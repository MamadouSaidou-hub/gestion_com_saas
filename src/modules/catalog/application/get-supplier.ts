import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { SupplierNotFoundError } from "../domain/errors";
import type { SupplierRepository } from "./ports";
import type { SupplierDto } from "./dto";
import { toSupplierDto } from "./mappers";

export async function getSupplier(
  ctx: TenantSessionContext,
  supplierId: string,
  repo: SupplierRepository
): Promise<SupplierDto> {
  assertCan(ctx.actor, "supplier:read");
  const row = await repo.findById(ctx, supplierId);
  if (!row) {
    throw new SupplierNotFoundError(supplierId);
  }
  return toSupplierDto(row);
}
