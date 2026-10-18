import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { SupplierRepository, ListSuppliersFilter } from "./ports";
import type { SupplierDto } from "./dto";
import { toSupplierDto } from "./mappers";

export async function listSuppliers(
  ctx: TenantSessionContext,
  filter: ListSuppliersFilter,
  repo: SupplierRepository
): Promise<SupplierDto[]> {
  assertCan(ctx.actor, "supplier:read");
  const rows = await repo.list(ctx, filter);
  return rows.map(toSupplierDto);
}
