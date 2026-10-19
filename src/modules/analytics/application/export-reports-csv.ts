import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { getReports } from "./get-reports";
import type { AnalyticsRepository } from "./ports";
import type { GetReportsInput, ReportsDto } from "./dto";

// exportReportsCsv -- gated on `report:export` (a DIFFERENT permission
// than `dashboard:read_financials`, which `getReports` itself still
// checks), then delegates to `getReports` UNCHANGED so the CSV export
// re-runs the exact same filtered/scoped query as the screen it exports
// from, never a separate "export everything" path -- same convention as
// sales' exportSalesCsv.
export async function exportReportsCsv(
  ctx: TenantSessionContext,
  input: GetReportsInput,
  repo: AnalyticsRepository
): Promise<ReportsDto> {
  assertCan(ctx.actor, "report:export");
  return getReports(ctx, input, repo);
}
