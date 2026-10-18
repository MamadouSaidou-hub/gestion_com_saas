import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { analyticsRepository } from "./infrastructure/analytics-repository";
import * as useCases from "./application";
import type { GetDashboardInput } from "./application";

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
} from "./application";
export type { PeriodGranularity } from "./domain";
