import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { InvoiceRepository } from "./ports";
import type { InvoiceDto } from "./dto";
import { toInvoiceDto } from "./mappers";

// getInvoiceForSale -- "has this sale been invoiced yet, and if so what's
// its doc number" for the sale document screen. No scope check beyond
// `invoice:read` here: the CALLER (the sale document page) already
// resolved the sale itself through getSaleDetail's own scope/store
// checks -- an invoice can only ever be reached by first reaching its
// sale, so re-deriving the same check here would be redundant, not an
// extra guarantee.
export async function getInvoiceForSale(
  ctx: TenantSessionContext,
  saleId: string,
  repo: InvoiceRepository
): Promise<InvoiceDto | null> {
  assertCan(ctx.actor, "invoice:read");
  const row = await repo.findBySaleId(ctx, saleId);
  return row ? toInvoiceDto(row) : null;
}
