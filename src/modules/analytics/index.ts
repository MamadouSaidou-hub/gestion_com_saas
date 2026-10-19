import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { analyticsRepository } from "./infrastructure/analytics-repository";
import { globalSearchRepository } from "./infrastructure/search-repository";
import * as useCases from "./application";
import type { GetDashboardInput, GetTreasuryInput, GetReportsInput } from "./application";

// ---------------------------------------------------------------------------
// analytics/index.ts -- the ONLY surface another module (or the RSC
// dashboard page) is allowed to import from. Composition root: wires the
// direct-indexed-query repository into the pure use cases.
//
// `getDashboard`/`getHeadline` are top-level, READ-ONLY use cases: the
// dashboard page opens its OWN `withTenantSession` for EACH ONE (two
// independent single-session use cases, not one transaction split in
// two) so the headline tile (CA + encaissé du jour) can resolve and paint
// behind its own Suspense boundary while the heavier tiles (top products,
// margin, seller breakdown, receivables) stream in behind a second one.
// ---------------------------------------------------------------------------

export const analyticsService = {
  getDashboard: (ctx: TenantSessionContext, input: GetDashboardInput) =>
    useCases.getDashboard(ctx, input, analyticsRepository),
  getHeadline: (ctx: TenantSessionContext, input: GetDashboardInput) =>
    useCases.getHeadline(ctx, input, analyticsRepository),
  getTreasury: (ctx: TenantSessionContext, input: GetTreasuryInput) =>
    useCases.getTreasury(ctx, input, analyticsRepository),
  getReports: (ctx: TenantSessionContext, input: GetReportsInput) =>
    useCases.getReports(ctx, input, analyticsRepository),
  exportReportsCsv: (ctx: TenantSessionContext, input: GetReportsInput) =>
    useCases.exportReportsCsv(ctx, input, analyticsRepository),
  globalSearch: (ctx: TenantSessionContext, query: string) =>
    useCases.globalSearch(ctx, query, globalSearchRepository),
  getNotifications: (ctx: TenantSessionContext) => useCases.getNotifications(ctx),
};

export type {
  DashboardDto,
  DashboardFinancialsDto,
  GetDashboardInput,
  TopProductDto,
  SellerBreakdownDto,
  LowStockAlertDto,
  MarginDto,
  ReceivablesDto,
  HeadlineDto,
  TreasuryDto,
  TreasurySupplierDto,
  GetTreasuryInput,
  ReportsDto,
  RevenueByStoreDto,
  GetReportsInput,
  SearchResultDto,
  NotificationItem,
  NotificationKind,
} from "./application";
export type { PeriodGranularity } from "./domain";
