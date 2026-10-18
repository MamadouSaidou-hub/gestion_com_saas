import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { Product } from "../domain/product";
import type { Category } from "../domain/category";

export interface ListProductsFilter {
  activeOnly?: boolean;
  search?: string;
  categoryId?: string;
}

export interface CreateProductInput {
  sku: string;
  name: string;
  unitId: string;
  categoryId?: string | null;
  currencyCode: string;
  defaultPriceMinor: bigint;
  defaultCostMinor: bigint;
  lowStockThreshold?: string | null;
}

export interface UpdateProductInput {
  name?: string;
  categoryId?: string | null;
  unitId?: string;
  defaultPriceMinor?: bigint;
  defaultCostMinor?: bigint;
  lowStockThreshold?: string | null;
}

export interface ProductRepository {
  findById(ctx: TenantSessionContext, productId: string): Promise<Product | null>;
  findBySku(ctx: TenantSessionContext, sku: string): Promise<Product | null>;
  list(ctx: TenantSessionContext, filter: ListProductsFilter): Promise<Product[]>;
  insert(ctx: TenantSessionContext, input: CreateProductInput): Promise<Product>;
  update(ctx: TenantSessionContext, productId: string, input: UpdateProductInput): Promise<Product>;
  setActive(ctx: TenantSessionContext, productId: string, isActive: boolean): Promise<Product>;
  // Bulk reassignment -- ONE UPDATE for every id in `productIds`, never a
  // per-product loop (that's the whole point of this method existing
  // separately from `update`: a designer-facing "select N products -> put
  // them in a rayon" action must not turn into N round trips). `categoryId:
  // null` removes every one of those products from whatever category they
  // were in. Returns how many rows were actually updated (ids outside this
  // tenant, or that don't exist, are silently excluded -- same semantics as
  // every other tenant-scoped WHERE in this repository).
  assignCategory(
    ctx: TenantSessionContext,
    productIds: string[],
    categoryId: string | null
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// Category ("rayon") repository port. Navigation grouping only -- a
// category never affects a product's own price or how it's sold.
// ---------------------------------------------------------------------------

export interface CreateCategoryInput {
  name: string;
  parentId: string | null;
}

export interface UpdateCategoryInput {
  name?: string;
  parentId?: string | null;
}

// Minimal projection used by the duplicate-name check -- just enough to
// feed the pure `isDuplicateCategoryName` domain function.
export interface CategorySiblingRecord {
  id: string;
  name: string;
}

export interface CategoryRepository {
  findById(ctx: TenantSessionContext, categoryId: string): Promise<Category | null>;
  // Flat list of every category in the tenant, each carrying its own
  // `parentId` -- this is also the snapshot `wouldCreateCycle` walks, and
  // what the UI uses to build the tree client-side (see
  // `catalogService.listCategories`'s doc comment for the exact shape).
  list(ctx: TenantSessionContext): Promise<Category[]>;
  // Siblings at one level (same parentId, `null` meaning top-level) --
  // used for the duplicate-name check without loading the whole tree.
  listByParent(
    ctx: TenantSessionContext,
    parentId: string | null
  ): Promise<CategorySiblingRecord[]>;
  insert(ctx: TenantSessionContext, input: CreateCategoryInput): Promise<Category>;
  update(
    ctx: TenantSessionContext,
    categoryId: string,
    input: UpdateCategoryInput
  ): Promise<Category>;
  delete(ctx: TenantSessionContext, categoryId: string): Promise<void>;
  countProducts(ctx: TenantSessionContext, categoryId: string): Promise<number>;
  countChildren(ctx: TenantSessionContext, categoryId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Warehouse ("Magasin") repository port -- migration 0014. Owner-gated
// create/archive (enforced in the use cases, not here); list is available
// to anyone with `warehouse:write` OR who simply needs the catalog for a
// store selector (list-warehouses.ts gates on `stock:read` instead, see
// its own comment).
// ---------------------------------------------------------------------------

export type WarehouseKind = "store" | "depot";

export interface WarehouseRecord {
  id: string;
  code: string;
  name: string;
  kind: WarehouseKind;
  isDefault: boolean;
  isActive: boolean;
  address: string | null;
  phone: string | null;
  createdAt: Date;
}

export interface CreateWarehouseInput {
  code: string;
  name: string;
  kind: WarehouseKind;
  address?: string | null;
  phone?: string | null;
}

export interface ListWarehousesFilter {
  activeOnly?: boolean;
  kind?: WarehouseKind;
}

export interface WarehouseRepository {
  findById(ctx: TenantSessionContext, warehouseId: string): Promise<WarehouseRecord | null>;
  findByCode(ctx: TenantSessionContext, code: string): Promise<WarehouseRecord | null>;
  list(ctx: TenantSessionContext, filter: ListWarehousesFilter): Promise<WarehouseRecord[]>;
  insert(ctx: TenantSessionContext, input: CreateWarehouseInput): Promise<WarehouseRecord>;
  setActive(ctx: TenantSessionContext, warehouseId: string, isActive: boolean): Promise<WarehouseRecord>;
}

export interface CustomerRecord {
  id: string;
  name: string;
}

export interface InsertCustomerInput {
  name: string;
}

export interface CustomerRepository {
  findByName(ctx: TenantSessionContext, name: string): Promise<CustomerRecord | null>;
  insert(ctx: TenantSessionContext, input: InsertCustomerInput): Promise<CustomerRecord>;
}
