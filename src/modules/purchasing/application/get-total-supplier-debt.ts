import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto } from "@/platform/dto/money";
import type { DeliveryRepository } from "./ports";
import type { SupplierDebtTotalDto } from "./dto";

// getTotalSupplierDebt -- tenant-level aggregate across every supplier,
// consumed by treasury (analytics module). Gated on `delivery:read`, same
// permission as the per-supplier `getSupplierDebt` -- the read side is not
// behind `supplier_payment:record`, so an actor can SEE the figure even if
// they cannot pay it off. Callers (e.g. analytics' getTreasury) are
// responsible for never issuing this query for a store-scoped actor at
// all -- supplier debt is consolidated at tenant level by product
// decision, so there is nothing store-scoped to show (see db/README entry
// 2y) -- "don't fetch what the actor may not see", not "fetch then hide".
export async function getTotalSupplierDebt(
  ctx: TenantSessionContext,
  repo: DeliveryRepository
): Promise<SupplierDebtTotalDto> {
  assertCan(ctx.actor, "delivery:read");
  const debtMinor = await repo.sumTotalDebt(ctx);
  return { debtMinor: moneyToDto(debtMinor) };
}
