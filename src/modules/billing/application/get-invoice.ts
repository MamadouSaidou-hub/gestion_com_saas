import { assertCan, scopeFor } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { salesService } from "@/modules/sales";
import { InvoiceNotFoundError } from "../domain/errors";
import type { InvoiceRepository } from "./ports";
import type { InvoiceDto } from "./dto";
import { toInvoiceDto } from "./mappers";

export async function getInvoice(
  ctx: TenantSessionContext,
  invoiceId: string,
  repo: InvoiceRepository
): Promise<InvoiceDto> {
  assertCan(ctx.actor, "invoice:read");
  const row = await repo.findById(ctx, invoiceId);
  if (!row) {
    throw new InvoiceNotFoundError(invoiceId);
  }
  const scope = scopeFor(ctx.actor, "invoice:read");
  if (scope === "own") {
    // M3 fix (security-reviewer, Medium): filter by the LINKED SALE's
    // created_by, not the invoice's own -- see listInvoices's comment.
    const createdByBySaleId = row.saleId
      ? await salesService.getCreatedByForSales(ctx, [row.saleId])
      : {};
    const ownsLinkedSale = row.saleId !== null && createdByBySaleId[row.saleId] === ctx.actor.userId;
    if (!ownsLinkedSale) {
      // Don't leak existence of another user's invoice to a scoped actor.
      throw new InvoiceNotFoundError(invoiceId);
    }
  }
  return toInvoiceDto(row);
}
