import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { SalesRepository } from "./ports";

// L-b fix (security-reviewer follow-up) support: lets billing's
// listInvoices/listPayments push the 'own' scope filter INTO SQL (a
// `sale_id IN (...)` WHERE clause on billing's own table) instead of
// fetching every tenant row and filtering in application memory. Ctx-based
// primitive, no `assertCan` (the caller already checked its own
// `invoice:read`/`payment:read`).
export async function listSaleIdsCreatedBy(
  ctx: TenantSessionContext,
  userId: string,
  repo: SalesRepository
): Promise<string[]> {
  return repo.listSaleIdsCreatedBy(ctx, userId);
}
