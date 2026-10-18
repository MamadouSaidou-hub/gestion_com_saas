import { assertCan, scopeFor, storeScopeFor } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { toSaleDetailDto } from "./mappers";
import type { SaleDetailDto } from "./dto";
import type { SalesRepository } from "./ports";

// ---------------------------------------------------------------------------
// getSaleDetail -- backs both the sale detail view and the printable
// ticket/invoice document. Returns `null` (never throws ForbiddenError) on
// any out-of-scope access -- a cashier guessing another cashier's sale id,
// or a gerant guessing a sale from a different store, gets exactly the same
// "not found" a nonexistent id would, per the task's explicit instruction:
// out-of-scope access is a 404, never a detailed 403 (no existence oracle).
// ---------------------------------------------------------------------------
export async function getSaleDetail(
  ctx: TenantSessionContext,
  saleId: string,
  repo: SalesRepository
): Promise<SaleDetailDto | null> {
  assertCan(ctx.actor, "sale:read");

  const header = await repo.findById(ctx, saleId);
  if (!header) {
    return null;
  }

  const scope = scopeFor(ctx.actor, "sale:read");
  if (scope === "own" && header.createdBy !== ctx.actor.userId) {
    return null;
  }
  const ownStore = storeScopeFor(ctx.actor);
  if (ownStore !== null && header.warehouseId !== ownStore) {
    return null;
  }

  const lines = await repo.listLines(ctx, saleId);
  return toSaleDetailDto(header, lines);
}
