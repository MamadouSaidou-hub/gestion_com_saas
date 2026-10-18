// Pure domain entity for a catalog product. No drizzle, no Next imports --
// this is what the application layer and callers reason about; the
// infrastructure layer maps it to/from `src/db/schema/catalog.ts`'s
// `products` row shape.
export interface Product {
  id: string;
  structureId: string;
  categoryId: string | null;
  // Denormalized at read time via a LEFT JOIN on product_categories (never
  // a second per-row query) so list/search can group products by rayon
  // without an N+1 -- null when categoryId is null (product has no rayon
  // yet) or, in principle, if the category was deleted out from under a
  // stale reference (shouldn't happen: deleteCategory blocks while
  // products still reference it, see category/delete-category.ts).
  categoryName: string | null;
  unitId: string;
  sku: string;
  name: string;
  currencyCode: string;
  defaultPriceMinor: bigint;
  defaultCostMinor: bigint;
  // numeric(18,4) string, or null if no threshold is configured. Use
  // `Quantity.fromString` (from the inventory module's public surface) to
  // operate on it -- never `Number()` it.
  lowStockThreshold: string | null;
  isActive: boolean;
  createdAt: Date;
}
