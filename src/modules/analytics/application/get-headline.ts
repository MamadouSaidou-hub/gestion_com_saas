import { assertCan, can } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto } from "@/platform/dto/money";
import { resolvePeriodWindow, isLiveWindowEnd } from "../domain/period";
import type { AnalyticsRepository } from "./ports";
import type { GetDashboardInput } from "./dto";
import type { MoneyMinorDto } from "@/platform/dto/money";

export interface HeadlineDto {
  ownSaleCount: number;
  ownTotalMinor: MoneyMinorDto;
  financials?: {
    caBrutMinor: MoneyMinorDto;
    caNetMinor: MoneyMinorDto;
    encaisseMinor: MoneyMinorDto;
  };
}

// ---------------------------------------------------------------------------
// getHeadline -- the ONE number an owner/manager checks first (CA +
// encaissé du jour), deliberately split from `getDashboard`'s heavier
// queries (top products, margin, seller breakdown, receivables) so the
// dashboard PAGE can paint this tile immediately while the rest streams
// in behind a second Suspense boundary. Each use case still respects
// "every query runs inside ONE withTenantSession" -- this is a second,
// independent use case with its OWN single session, not a second
// transaction nested inside getDashboard's.
// ---------------------------------------------------------------------------
export async function getHeadline(
  ctx: TenantSessionContext,
  input: GetDashboardInput,
  repo: AnalyticsRepository
): Promise<HeadlineDto> {
  assertCan(ctx.actor, "dashboard:read");

  const referenceDate = input.referenceDate ?? new Date();
  const window = resolvePeriodWindow(input.period, referenceDate);
  const current = { start: window.currentStart, end: window.currentEnd };

  const ownSummary = await repo.getOwnSalesSummary(ctx, ctx.actor.userId, current);
  const base: HeadlineDto = {
    ownSaleCount: ownSummary.saleCount,
    ownTotalMinor: moneyToDto(ownSummary.totalMinor),
  };

  if (!can(ctx.actor, "dashboard:read_financials")) {
    return base;
  }

  const [totals, encaisse] = await Promise.all([
    repo.getSalesWindowTotals(ctx, current),
    // H5 fix, made conditional by M-c -- see isLiveWindowEnd's comment
    // (domain/period.ts) and get-dashboard.ts's identical call site.
    repo.getEncaisse(ctx, isLiveWindowEnd(current.end) ? { start: current.start } : current),
  ]);

  base.financials = {
    caBrutMinor: moneyToDto(totals.grossMinor),
    caNetMinor: moneyToDto(totals.netMinor),
    encaisseMinor: moneyToDto(encaisse),
  };
  return base;
}
