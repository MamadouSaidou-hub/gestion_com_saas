import { assertCan, can, resolveStoreScope } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto } from "@/platform/dto/money";
import { billingService } from "@/modules/billing";
import { inventoryService } from "@/modules/inventory";
import {
  resolvePeriodWindow,
  resolveRollingWindow,
  isLiveWindowEnd,
  computeAverageBasketMinor,
  computeMargin,
} from "../domain";
import type { AnalyticsRepository } from "./ports";
import type { DashboardDto, GetDashboardInput, TopProductDto } from "./dto";

const TOP_PRODUCTS_WINDOW_DAYS = 30;
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
// getDashboard -- read-only, direct indexed queries, all fired in
// PARALLEL inside the caller's single `withTenantSession`.
//
// "Don't fetch what the actor may not see": the financial branch (CA,
// encaissé, margin, seller breakdown, ...) is gated on
// `dashboard:read_financials` BEFORE any of those queries are even
// issued -- a cashier's response object never contains computed-then-
// hidden financial fields, the `financials` key is simply absent.
// ---------------------------------------------------------------------------
export async function getDashboard(
  ctx: TenantSessionContext,
  input: GetDashboardInput,
  repo: AnalyticsRepository
): Promise<DashboardDto> {
  assertCan(ctx.actor, "dashboard:read");

  const referenceDate = input.referenceDate ?? new Date();
  const window = resolvePeriodWindow(input.period, referenceDate);
  const current = { start: window.currentStart, end: window.currentEnd };

  // multi-store: a gerant ALWAYS gets their own store regardless of what
  // (if anything) was requested; an unscoped actor (owner) gets the
  // requested store or every store (`null`) when none was selected -- see
  // resolveStoreScope's doc comment. This single value floors EVERY query
  // below, replacing the old single-warehouse `getDefaultWarehouseId()`
  // lookup this function used to lean on.
  const storeScope = resolveStoreScope(ctx.actor, input.warehouseId);

  const [ownSummary, lowStockAlerts] = await Promise.all([
    repo.getOwnSalesSummary(ctx, ctx.actor.userId, current, storeScope),
    inventoryService.listLowStock(ctx, storeScope),
  ]);

  const base: DashboardDto = {
    period: input.period,
    windowStart: window.currentStart.toISOString(),
    windowEnd: window.currentEnd.toISOString(),
    ownSaleCount: ownSummary.saleCount,
    ownTotalMinor: moneyToDto(ownSummary.totalMinor),
    lowStockAlerts,
  };

  if (!can(ctx.actor, "dashboard:read_financials")) {
    return base;
  }

  const previous = { start: window.previousStart, end: window.previousEnd };
  const topProductsWindow = resolveRollingWindow(TOP_PRODUCTS_WINDOW_DAYS, referenceDate);

  const [
    currentTotals,
    previousTotals,
    currentEncaisse,
    previousEncaisse,
    encaisseByMethod,
    receivables,
    topProductsRaw,
    marginTotals,
    sellerBreakdown,
    vatRate,
  ] = await Promise.all([
    repo.getSalesWindowTotals(ctx, current, storeScope),
    repo.getSalesWindowTotals(ctx, previous, storeScope),
    // H5 fix, made conditional by M-c: the upper bound is only dropped
    // when `current.end` genuinely means "now" (today, never a
    // client-supplied past date) -- see isLiveWindowEnd's comment
    // (domain/period.ts). The PREVIOUS window always keeps its real
    // upper bound (a fixed point in the past, never "now").
    repo.getEncaisse(ctx, isLiveWindowEnd(current.end) ? { start: current.start } : current, storeScope),
    repo.getEncaisse(ctx, previous, storeScope),
    repo.getEncaisseByMethod(
      ctx,
      isLiveWindowEnd(current.end) ? { start: current.start } : current,
      storeScope
    ),
    billingService.getReceivables(ctx),
    repo.getTopProductsRaw(ctx, topProductsWindow, storeScope),
    repo.getMarginTotals(ctx, current, storeScope),
    repo.getSellerBreakdown(ctx, current, storeScope),
    billingService.getVatRate(ctx),
  ]);

  const byRevenue = [...topProductsRaw]
    .sort((a, b) => (b.revenueMinor > a.revenueMinor ? 1 : b.revenueMinor < a.revenueMinor ? -1 : 0))
    .slice(0, TOP_PRODUCTS_LIMIT)
    .map(toTopProductDto);
  const byQuantity = [...topProductsRaw]
    .sort((a, b) => Number(b.quantity) - Number(a.quantity))
    .slice(0, TOP_PRODUCTS_LIMIT)
    .map(toTopProductDto);

  const margin = computeMargin(marginTotals.revenueMinor, marginTotals.costMinor);
  const averageBasketMinor = computeAverageBasketMinor(currentTotals.netMinor, currentTotals.netCount);
  const vatRateIsPositive = Number(vatRate) > 0;

  base.financials = {
    caBrutMinor: moneyToDto(currentTotals.grossMinor),
    caNetMinor: moneyToDto(currentTotals.netMinor),
    vatMinor: vatRateIsPositive ? moneyToDto(sumVat(marginTotals.revenueMinor, vatRate)) : null,
    encaisseMinor: moneyToDto(currentEncaisse),
    encaisseByMethod: encaisseByMethod.map((row) => ({ method: row.method, amountMinor: moneyToDto(row.amountMinor) })),
    receivables,
    saleCount: currentTotals.netCount,
    averageBasketMinor: moneyToDto(averageBasketMinor),
    topProductsByRevenue: byRevenue,
    topProductsByQuantity: byQuantity,
    margin: {
      revenueMinor: moneyToDto(margin.revenueMinor),
      costMinor: moneyToDto(margin.costMinor),
      marginMinor: moneyToDto(margin.marginMinor),
      marginPct: margin.marginPct,
    },
    sellerBreakdown: sellerBreakdown.map((row) => ({
      sellerId: row.sellerId,
      saleCount: row.saleCount,
      totalMinor: moneyToDto(row.totalMinor),
    })),
    comparisonToPreviousPeriod: {
      caBrutMinor: moneyToDto(previousTotals.grossMinor),
      caNetMinor: moneyToDto(previousTotals.netMinor),
      encaisseMinor: moneyToDto(previousEncaisse),
    },
  };

  return base;
}

// Reconstructs the VAT portion of TTC revenue for display ONLY (the VAT
// line is shown when `tax_settings.vat_rate > 0`, per D4 -- many small
// shops aren't VAT-registered). Not a fiscal computation -- `sale_lines`
// already stores the authoritative per-line VAT at confirmation time;
// this is an approximation (revenue * rate / (100+rate)) for a single
// dashboard summary tile, not meant to reconcile to the cent against a
// line-by-line sum. Judgment call, flagged for an accountant review.
function sumVat(revenueMinorTTC: bigint, vatRate: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(vatRate.trim());
  if (!match) {
    return 0n;
  }
  const [, intPart, fracPartRaw] = match;
  const fracPart = (fracPartRaw ?? "").padEnd(2, "0").slice(0, 2);
  const scaledPercent = BigInt(intPart) * 100n + BigInt(fracPart === "" ? "0" : fracPart); // percent * 100
  // VAT = TTC * rate / (100 + rate), scaled consistently (both sides * 100).
  const denominator = 10_000n + scaledPercent;
  if (denominator === 0n) {
    return 0n;
  }
  return (revenueMinorTTC * scaledPercent + denominator / 2n) / denominator;
}
