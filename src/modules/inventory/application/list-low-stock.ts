import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { catalogService } from "@/modules/catalog";
import { Quantity } from "../domain/quantity";
import type { StockRepository } from "./ports";

export interface LowStockAlert {
  productId: string;
  sku: string;
  name: string;
  warehouseId: string;
  quantity: string;
  lowStockThreshold: string;
}

// ---------------------------------------------------------------------------
// listLowStock -- cross-module read composed through catalog's PUBLIC
// service surface (`catalogService.listProducts`), never by importing
// `@/db/schema/catalog` from inventory. `products.low_stock_threshold` is
// catalog-owned data; `stock_levels.quantity` is inventory-owned data. The
// hard boundary rule means this costs an extra round trip (fetch all
// products with a threshold configured, then cross-reference against
// stock_levels in memory) instead of a single SQL join -- acceptable at
// this data volume; flagged here as a deliberate trade-off, not an
// oversight, should it ever need to become a dedicated indexed query.
//
// multi-store (migration 0014): `storeScope` is REQUIRED, not optional --
// `null` means "every store the actor can see" (aggregates low-stock
// alerts across EVERY active warehouse in the tenant, one alert per
// product x store, same shape as before), a warehouse id means "exactly
// that store" (a gerant's own store, or an owner's explicit selector
// choice). The single-warehouse `getDefaultWarehouseId()` fallback this
// used to lean on is gone -- a tenant with several stores never had a
// single meaningful "default" for this alert list.
// ---------------------------------------------------------------------------
export async function listLowStock(
  ctx: TenantSessionContext,
  repo: StockRepository,
  storeScope: string | null
): Promise<LowStockAlert[]> {
  assertCan(ctx.actor, "stock:read");

  const products = await catalogService.listProducts(ctx, { activeOnly: true });
  const thresholded = products.filter((p) => p.lowStockThreshold !== null);
  if (thresholded.length === 0) {
    return [];
  }
  const productIds = thresholded.map((p) => p.id);

  // Enumerate the TARGET warehouse ids: either exactly the one store scope
  // resolves to, or (storeScope === null) every active warehouse in the
  // tenant -- this is what lets a missing `stock_levels` row still surface
  // as "0 in stock, below threshold" per warehouse, same as the
  // single-store behaviour this replaces, instead of silently vanishing
  // from the alert list the moment a product has never been received into
  // a given store.
  const targetWarehouseIds = storeScope
    ? [storeScope]
    : (await catalogService.listWarehouses(ctx, { activeOnly: true })).map((w) => w.id);
  if (targetWarehouseIds.length === 0) {
    return [];
  }

  const alerts: LowStockAlert[] = [];
  for (const warehouseId of targetWarehouseIds) {
    const levels = await repo.listLevels(ctx, { warehouseId, productIds });
    const levelByProductId = new Map(levels.map((l) => [l.productId, l]));

    for (const product of thresholded) {
      const level = levelByProductId.get(product.id);
      const quantity = level?.quantity ?? Quantity.zero();
      // lowStockThreshold is validated non-null by the filter above.
      const threshold = Quantity.fromString(product.lowStockThreshold as string);
      if (quantity.lessThan(threshold)) {
        alerts.push({
          productId: product.id,
          sku: product.sku,
          name: product.name,
          warehouseId,
          quantity: quantity.toDbString(),
          lowStockThreshold: threshold.toDbString(),
        });
      }
    }
  }
  return alerts;
}
