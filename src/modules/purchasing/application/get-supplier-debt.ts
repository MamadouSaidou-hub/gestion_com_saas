import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { DeliveryRepository } from "./ports";
import type { SupplierDebtDto } from "./dto";
import { toSupplierDebtDto } from "./mappers";

// getSupplierDebt -- TENANT-level aggregate (never store-scoped, see module
// header note in ports.ts / db/README entry 2y). Available to `delivery:read`
// holders -- the read side is not gated behind supplier_payment:record, a
// gerant may still SEE a supplier's consolidated debt even though they
// cannot pay it off.
export async function getSupplierDebt(
  ctx: TenantSessionContext,
  supplierId: string,
  repo: DeliveryRepository
): Promise<SupplierDebtDto> {
  assertCan(ctx.actor, "delivery:read");
  const debtMinor = await repo.sumDebtBySupplier(ctx, supplierId);
  return toSupplierDebtDto(supplierId, debtMinor);
}
