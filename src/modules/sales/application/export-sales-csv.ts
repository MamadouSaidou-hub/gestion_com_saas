import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { listSales } from "./list-sales";
import type { ListSalesInput, SaleSummaryDto } from "./dto";
import type { SalesRepository } from "./ports";

// exportSalesCsv -- gated on `report:export` (a DIFFERENT permission than
// `sale:read`, which `listSales` itself still checks), then delegates to
// `listSales` UNCHANGED so the CSV export re-runs the exact same
// filtered/scoped query as the screen it exports from, never a separate
// "export everything" path.
export async function exportSalesCsv(
  ctx: TenantSessionContext,
  input: ListSalesInput,
  repo: SalesRepository
): Promise<SaleSummaryDto[]> {
  assertCan(ctx.actor, "report:export");
  return listSales(ctx, input, repo);
}
