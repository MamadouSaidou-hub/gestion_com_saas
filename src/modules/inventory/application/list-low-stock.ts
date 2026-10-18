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
// ---------------------------------------------------------------------------
export async function listLowStock(
  ctx: TenantSessionContext,
  warehouseId: string,
  repo: StockRepository
): Promise<LowStockAlert[]> {
  assertCan(ctx.actor, "stock:read");

  const products = await catalogService.listProducts(ctx, { activeOnly: true });
  const thresholded = products.filter((p) => p.lowStockThreshold !== null);
  if (thresholded.length === 0) {
    return [];
  }

  const levels = await repo.listLevels(ctx, {
    warehouseId,
    productIds: thresholded.map((p) => p.id),
  });
  const levelByProductId = new Map(levels.map((l) => [l.productId, l]));

  const alerts: LowStockAlert[] = [];
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
  return alerts;
}
