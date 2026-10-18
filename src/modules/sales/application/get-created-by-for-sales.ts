import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { SalesRepository } from "./ports";

// M3 fix (security-reviewer, Medium) support: billing's listInvoices/
// listPayments/getInvoice filter their 'own' scope by the LINKED SALE's
// created_by, not the invoice/payment row's own created_by (an invoice's
// creator is typically the accountant who issued it, not the cashier who
// sold it -- filtering by the document's own created_by protected
// nothing useful for a cashier). Ctx-based primitive, no `assertCan` (the
// caller already checked its own `invoice:read`/`payment:read`).
//
// L-b fix (security-reviewer follow-up): was an N+1 (`findById` per sale
// id, in a loop) -- now a single batched query via the repository's
// `findCreatedByForSaleIds`.
export async function getCreatedByForSales(
  ctx: TenantSessionContext,
  saleIds: string[],
  repo: SalesRepository
): Promise<Record<string, string>> {
  return repo.findCreatedByForSaleIds(ctx, saleIds);
}
