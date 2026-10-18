import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { StockRepository, ListMovementsFilter } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export async function listMovements(
  ctx: TenantSessionContext,
  filter: ListMovementsFilter,
  repo: StockRepository
): Promise<StockMovementDto[]> {
  assertCan(ctx.actor, "stock:read");
  const movements = await repo.listMovements(ctx, filter);
  return movements.map(toMovementDto);
}
