import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { StockCountDto, VarianceLineDto } from "./dto";
import type { StockCountsRepository, ListStockCountsFilter, ListVarianceLinesFilter } from "./ports";
import { toStockCountDto, toVarianceLineDto } from "./mappers";

export async function listStockCounts(
  ctx: TenantSessionContext,
  filter: ListStockCountsFilter,
  repo: StockCountsRepository
): Promise<StockCountDto[]> {
  assertCan(ctx.actor, "count:open");
  const headers = await repo.list(ctx, filter);
  return Promise.all(
    headers.map(async (header) => {
      const lines = await repo.listLines(ctx, header.id);
      return toStockCountDto(header, lines, false);
    })
  );
}

// "Écarts récents" -- stock_count_lines where variance != 0, store-scoped,
// newest first (db/README's floor/ceiling split: stock_count_lines is
// floor-only RLS, reached here only by joining an already store-scoped
// header -- see ports.ts's VarianceLineRow doc comment).
export async function listVarianceLines(
  ctx: TenantSessionContext,
  filter: ListVarianceLinesFilter,
  repo: StockCountsRepository
): Promise<VarianceLineDto[]> {
  assertCan(ctx.actor, "stock:read");
  const rows = await repo.listVarianceLines(ctx, filter);
  return rows.map(toVarianceLineDto);
}
