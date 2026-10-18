import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { WarehouseRepository, ListWarehousesFilter } from "./ports";
import type { WarehouseDto } from "./dto";
import { toWarehouseDto } from "./mappers";

// ---------------------------------------------------------------------------
// listWarehouses -- gated on `stock:read` rather than `warehouse:write`:
// every role that can see stock levels at all (cashier via the POS store
// selector, stock_keeper, manager, owner) needs to be able to list stores,
// but only an owner may CREATE/ARCHIVE one (see create-warehouse.ts /
// archive-warehouse.ts). RLS puts no floor-level restriction on this list
// itself (a gerant's own store scope is about stock_movements/stock_levels/
// sales/payments rows, NOT about which warehouses exist) -- a gerant is
// still allowed to know the tenant's other stores exist (needed for the
// "assign a store" screen and for showing a disabled/locked indicator), the
// store-SCOPE restriction is enforced where DATA is read, not on this
// directory listing.
// ---------------------------------------------------------------------------
export async function listWarehouses(
  ctx: TenantSessionContext,
  filter: ListWarehousesFilter,
  repo: WarehouseRepository
): Promise<WarehouseDto[]> {
  assertCan(ctx.actor, "stock:read");
  const warehouses = await repo.list(ctx, filter);
  return warehouses.map(toWarehouseDto);
}
