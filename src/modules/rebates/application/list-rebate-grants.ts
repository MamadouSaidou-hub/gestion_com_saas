import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { RebateRepository } from "./ports";
import type { RebateGrantDto } from "./dto";
import { toRebateGrantDto } from "./mappers";

export async function listRebateGrants(
  ctx: TenantSessionContext,
  scaleId: string,
  repo: RebateRepository
): Promise<RebateGrantDto[]> {
  assertCan(ctx.actor, "rebate:read");
  const rows = await repo.listGrantsByScale(ctx, scaleId);
  return rows.map(toRebateGrantDto);
}
