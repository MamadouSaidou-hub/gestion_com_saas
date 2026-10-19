import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { RebateRepository } from "./ports";
import type { RebateGrantDto } from "./dto";
import { toRebateGrantDto } from "./mappers";

// listRecentGrants -- notifications' "palier atteint" source. Gated on
// `rebate:read`, tenant-wide (rebates aren't store-scoped -- customer/
// supplier level only, same as every other rebate read).
export async function listRecentGrants(
  ctx: TenantSessionContext,
  sinceExclusive: Date,
  repo: RebateRepository
): Promise<Array<RebateGrantDto & { customerId: string | null; supplierId: string | null }>> {
  assertCan(ctx.actor, "rebate:read");
  const rows = await repo.listRecentGrants(ctx, sinceExclusive);
  return rows.map((row) => ({ ...toRebateGrantDto(row), customerId: row.customerId, supplierId: row.supplierId }));
}
