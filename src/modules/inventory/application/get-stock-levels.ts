import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { StockRepository, ListLevelsFilter } from "./ports";
import type { StockLevelDto } from "./dto";
import { toStockLevelDto } from "./mappers";

export async function getStockLevels(
  ctx: TenantSessionContext,
  filter: ListLevelsFilter,
  repo: StockRepository
): Promise<StockLevelDto[]> {
  assertCan(ctx.actor, "stock:read");
  const levels = await repo.listLevels(ctx, filter);
  return levels.map(toStockLevelDto);
}
