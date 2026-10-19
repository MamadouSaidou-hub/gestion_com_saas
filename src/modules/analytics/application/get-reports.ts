import { assertCan, resolveStoreScope } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto } from "@/platform/dto/money";
import { resolvePeriodWindow } from "../domain/period";
import type { AnalyticsRepository } from "./ports";
import type { GetReportsInput, ReportsDto, TopProductDto } from "./dto";

const TOP_PRODUCTS_LIMIT = 5;

function toTopProductDto(row: {
  productId: string;
  sku: string;
  name: string;
  revenueMinor: bigint;
  quantity: string;
}): TopProductDto {
  return {
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    revenueMinor: moneyToDto(row.revenueMinor),
    quantity: row.quantity,
  };
}

// ---------------------------------------------------------------------------
// getReports -- "Rapports" screen: revenue by store, top products, by
// period. Gated on `dashboard:read_financials` -- same financial-visibility
// tier as the dashboard's heavy tiles, not a new permission, since this
// screen shows nothing a `dashboard:read_financials` holder couldn't
// already see on the dashboard, just reorganized for a chosen period/store.
// Same direct-indexed-query discipline as getDashboard (no materialized
// view) -- see docs/platform.md's revisit trigger.
// ---------------------------------------------------------------------------
export async function getReports(
  ctx: TenantSessionContext,
  input: GetReportsInput,
  repo: AnalyticsRepository
): Promise<ReportsDto> {
  assertCan(ctx.actor, "dashboard:read_financials");

  const referenceDate = input.referenceDate ?? new Date();
  const window = resolvePeriodWindow(input.period, referenceDate);
  const current = { start: window.currentStart, end: window.currentEnd };
  const storeScope = resolveStoreScope(ctx.actor, input.warehouseId);

  const [revenueByStoreRaw, topProductsRaw] = await Promise.all([
    repo.getRevenueByStore(ctx, current, storeScope),
    repo.getTopProductsRaw(ctx, current, storeScope),
  ]);

  const byRevenue = [...topProductsRaw]
    .sort((a, b) => (b.revenueMinor > a.revenueMinor ? 1 : b.revenueMinor < a.revenueMinor ? -1 : 0))
    .slice(0, TOP_PRODUCTS_LIMIT)
    .map(toTopProductDto);
  const byQuantity = [...topProductsRaw]
    .sort((a, b) => Number(b.quantity) - Number(a.quantity))
    .slice(0, TOP_PRODUCTS_LIMIT)
    .map(toTopProductDto);

  return {
    period: input.period,
    windowStart: window.currentStart.toISOString(),
    windowEnd: window.currentEnd.toISOString(),
    revenueByStore: revenueByStoreRaw.map((row) => ({
      warehouseId: row.warehouseId,
      netMinor: moneyToDto(row.netMinor),
      saleCount: row.netCount,
    })),
    topProductsByRevenue: byRevenue,
    topProductsByQuantity: byQuantity,
  };
}
