import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { DeliveryRepository, ListDeliveriesFilter } from "./ports";
import type { DeliveryDto } from "./dto";
import { toDeliveryDto } from "./mappers";

// listDeliveries -- store-scoped (a gerant sees their store's deliveries
// only; `filter.storeScope` is REQUIRED, resolved by the caller via
// resolveStoreScope, never guessed here). Lines are NOT fetched per
// delivery for the list view (display-oriented, mirrors listInvoices'
// shape) -- callers needing lines use getDelivery-equivalent detail reads.
export async function listDeliveries(
  ctx: TenantSessionContext,
  filter: ListDeliveriesFilter,
  repo: DeliveryRepository
): Promise<DeliveryDto[]> {
  assertCan(ctx.actor, "delivery:read");
  const rows = await repo.list(ctx, filter);
  return rows.map((row) => toDeliveryDto(row, [], false));
}
