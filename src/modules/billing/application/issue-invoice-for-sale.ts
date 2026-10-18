import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { salesService } from "@/modules/sales";
import { SaleNotFoundError, SaleNotConfirmedError, InvalidPaymentInputError } from "../domain/errors";
import type { InvoiceRepository, TaxSettingsRepository, DocumentCounterRepository } from "./ports";
import type { InvoiceDto, InvoiceStatus } from "./dto";
import { toInvoiceDto } from "./mappers";

export interface IssueInvoiceRepos {
  invoiceRepo: InvoiceRepository;
  taxSettingsRepo: TaxSettingsRepository;
  documentCounterRepo: DocumentCounterRepository;
}

// ---------------------------------------------------------------------------
// issueInvoiceForSale -- the "invoice on demand" path: a sale already has
// a TICKET (confirmSale's own numbering); this creates the separate
// INVOICE document, with its OWN gapless counter (doc_type='invoice',
// never shares a sequence with tickets).
//
// Idempotent-ish via `ON CONFLICT (structure_id, sale_id) WHERE sale_id IS
// NOT NULL DO NOTHING RETURNING *` (migration 0011) -- asking twice for
// the same sale returns the SAME invoice. Known, documented limitation
// (judgment call, flagged in db/README.md 2t): the invoice NUMBER is
// allocated BEFORE the conflict check (the number is part of the row
// being inserted), so a genuine race between two concurrent requests for
// the SAME sale can burn a number on the losing side even though it still
// correctly returns the winner's invoice, not a second one. Unlike
// confirmSale's ticket numbering, gaplessness under concurrency for
// invoices was not a hard requirement in this step's spec.
// ---------------------------------------------------------------------------
export async function issueInvoiceForSale(
  ctx: TenantSessionContext,
  saleId: string,
  repos: IssueInvoiceRepos
): Promise<InvoiceDto> {
  assertCan(ctx.actor, "invoice:issue");

  const sale = await salesService.getSaleForBilling(ctx, saleId);
  if (!sale) {
    throw new SaleNotFoundError(saleId);
  }
  if (sale.status !== "confirmed") {
    throw new SaleNotConfirmedError(saleId);
  }

  // Correction (coordinator feedback): use the SALE's own fiscal year --
  // when the transaction economically happened -- not the issue date. A
  // January invoice for a December sale belongs to December's sequence;
  // numbering it under the issue date would misrepresent which period it
  // belongs to. `sale.fiscalYear` is always set for a confirmed sale (set
  // by confirmSale at ticket allocation time); the `?? current year`
  // fallback only guards a state that should be unreachable here. Still
  // flagged for a local fiscalist to confirm (D4) -- default to the
  // sale's year unless told otherwise.
  const fiscalYear = sale.fiscalYear ?? new Date().getUTCFullYear();
  const prefix = (await repos.taxSettingsRepo.getInvoicePrefix(ctx)) ?? "INV";
  const number = await repos.documentCounterRepo.allocateNext(ctx, "invoice", fiscalYear);
  const docNumber = `${prefix}-${fiscalYear}-${number.toString().padStart(6, "0")}`;

  const totalMinor = moneyFromDto(sale.totalMinor);
  const paidMinor = moneyFromDto(sale.paidMinor);
  const status: InvoiceStatus =
    sale.paymentStatus === "paid" ? "paid" : sale.paymentStatus === "partial" ? "partially_paid" : "issued";

  const inserted = await repos.invoiceRepo.tryInsertForSale(ctx, {
    saleId,
    customerId: sale.customerId,
    docNumber,
    fiscalYear,
    currencyCode: sale.currencyCode,
    totalMinor,
    paidMinor,
    status,
    issuedAt: new Date(),
    createdBy: ctx.actor.userId,
  });

  if (!inserted) {
    const existing = await repos.invoiceRepo.findBySaleId(ctx, saleId);
    if (!existing) {
      throw new InvalidPaymentInputError("Could not issue or find the invoice for this sale -- retry.");
    }
    return toInvoiceDto(existing);
  }

  await ctx.audit.append({
    action: "invoice.issued",
    targetType: "invoice",
    targetId: inserted.id,
    payload: {
      saleId,
      docNumber: inserted.docNumber,
      totalMinor: moneyToDto(inserted.totalMinor),
      paidMinor: moneyToDto(inserted.paidMinor),
    },
  });

  return toInvoiceDto(inserted);
}
