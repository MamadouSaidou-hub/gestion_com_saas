import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { listMovements } from "./list-movements";
import type { StockRepository, ListMovementsFilter } from "./ports";
import type { StockMovementDto } from "./dto";

// Same convention as sales' exportSalesCsv -- gated on `report:export`
// (distinct from `stock:read`, which `listMovements` itself still checks),
// then delegates UNCHANGED so the CSV re-runs the exact filtered/scoped
// query the stock-movements screen shows.
export async function exportMovementsCsv(
  ctx: TenantSessionContext,
  filter: ListMovementsFilter,
  repo: StockRepository
): Promise<StockMovementDto[]> {
  assertCan(ctx.actor, "report:export");
  return listMovements(ctx, filter, repo);
}
