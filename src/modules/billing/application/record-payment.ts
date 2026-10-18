import { z } from "zod";
import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { salesService } from "@/modules/sales";
import { SaleNotFoundError, SaleNotConfirmedError, InvalidPaymentInputError } from "../domain/errors";
import type { PaymentRepository, InvoiceRepository } from "./ports";
import type { RecordPaymentInput, PaymentDto } from "./dto";
import { toPaymentDto } from "./mappers";

const PAYMENT_METHODS = ["cash", "mobile_money", "bank_transfer", "card", "other"] as const;

const recordPaymentSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  amountMinor: z.string().regex(/^\d+$/),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable().optional(),
  saleId: z.uuid(),
});

export interface RecordPaymentRepos {
  paymentRepo: PaymentRepository;
  invoiceRepo: InvoiceRepository;
}

// ---------------------------------------------------------------------------
// recordPayment -- pay off a credit sale LATER, outside the POS flow. This
// is a TOP-LEVEL use case: the caller opens its OWN `withTenantSession`
// (own transaction), separate from `confirmSale`'s. Idempotent the same
// way `confirmSale` is: `ON CONFLICT (structure_id, idempotency_key) DO
// NOTHING RETURNING *`, never a pre-SELECT.
// ---------------------------------------------------------------------------
export async function recordPayment(
  ctx: TenantSessionContext,
  rawInput: RecordPaymentInput,
  repos: RecordPaymentRepos
): Promise<PaymentDto> {
  assertCan(ctx.actor, "payment:record");
  const input = recordPaymentSchema.parse(rawInput);
  const amountMinor = moneyFromDto(input.amountMinor);
  if (amountMinor <= 0n) {
    throw new InvalidPaymentInputError("Payment amount must be strictly positive.");
  }

  const sale = await salesService.getSaleForBilling(ctx, input.saleId);
  if (!sale) {
    throw new SaleNotFoundError(input.saleId);
  }
  if (sale.status !== "confirmed") {
    throw new SaleNotConfirmedError(input.saleId);
  }

  const inserted = await repos.paymentRepo.tryInsertStandalone(ctx, {
    saleId: input.saleId,
    customerId: sale.customerId,
    amountMinor,
    currencyCode: sale.currencyCode,
    method: input.method,
    idempotencyKey: input.idempotencyKey,
    reference: input.reference ?? null,
    createdBy: ctx.actor.userId,
    receivedAt: new Date(), // H5 fix -- explicit app clock, not DB DEFAULT now()
  });

  if (!inserted) {
    // Replay -- same reasoning as confirmSale: the existing row can only
    // be visible here because a prior call already committed, so the
    // sale/invoice progress it caused is already applied. No second
    // mutation, no second audit entry.
    const existing = await repos.paymentRepo.findByIdempotencyKey(ctx, input.idempotencyKey);
    if (!existing) {
      throw new InvalidPaymentInputError(
        "Could not record or find the payment for this idempotency key -- retry."
      );
    }
    return toPaymentDto(existing);
  }

  // Update the sale's running paid total/status. recordPaymentProgress
  // throws PaymentExceedsTotalError if this would overpay -- since this
  // whole function runs inside the caller's transaction, that throw rolls
  // back the payment insert above too (no orphan row).
  await salesService.recordPaymentProgress(ctx, { saleId: input.saleId, deltaMinor: amountMinor });

  // Keep an existing invoice (if any) in sync -- "tickets by default,
  // invoice on demand" means most sales have none, but if one was issued,
  // its paid_minor/status must reflect this payment too. Atomic delta
  // (C1 fix) -- see invoice-repository.ts's updatePaymentProgress.
  const invoice = await repos.invoiceRepo.findBySaleId(ctx, input.saleId);
  if (invoice) {
    const updatedInvoice = await repos.invoiceRepo.updatePaymentProgress(ctx, invoice.id, {
      deltaMinor: amountMinor,
    });
    if (!updatedInvoice) {
      throw new InvalidPaymentInputError("This payment would exceed the invoice's outstanding balance.");
    }
    await repos.paymentRepo.insertAllocation(ctx, {
      paymentId: inserted.id,
      invoiceId: invoice.id,
      amountMinor,
      currencyCode: sale.currencyCode,
    });
  }

  // ids + amounts only -- no PII.
  await ctx.audit.append({
    action: "payment.recorded",
    targetType: "payment",
    targetId: inserted.id,
    payload: {
      saleId: input.saleId,
      amountMinor: moneyToDto(amountMinor),
      method: input.method,
      idempotencyKey: input.idempotencyKey,
    },
  });

  return toPaymentDto(inserted);
}
