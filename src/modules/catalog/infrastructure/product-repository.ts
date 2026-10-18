import { and, eq, ilike, inArray, or } from "drizzle-orm";
import { productCategories, products } from "@/db/schema/catalog";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { Product } from "../domain/product";
import type {
  ProductRepository,
  ListProductsFilter,
  CreateProductInput,
  UpdateProductInput,
} from "../application/ports";

// Drizzle implementation of the ProductRepository port. This is one of two
// files in the catalog module allowed to import `@/db/schema/catalog`
// (with category-repository.ts; enforced by the ESLint layering rule) --
// domain/application/api/index never see a drizzle row shape, only the
// `Product`/`Category` domain types.

// Flat column selection shared by every read path (findById/findBySku/
// list), LEFT JOINed against product_categories so `categoryName` is
// resolved in the SAME query -- never a per-row follow-up lookup, which is
// exactly the N+1 this shape exists to avoid. `categoryName` comes back
// `null` both when `categoryId` is null and if the LEFT JOIN simply finds
// no match.
const PRODUCT_READ_COLUMNS = {
  id: products.id,
  structureId: products.structureId,
  categoryId: products.categoryId,
  categoryName: productCategories.name,
  unitId: products.unitId,
  sku: products.sku,
  name: products.name,
  currencyCode: products.currencyCode,
  defaultPriceMinor: products.defaultPriceMinor,
  defaultCostMinor: products.defaultCostMinor,
  lowStockThreshold: products.lowStockThreshold,
  isActive: products.isActive,
  createdAt: products.createdAt,
};

type ProductReadRow = {
  id: string;
  structureId: string;
  categoryId: string | null;
  categoryName: string | null;
  unitId: string;
  sku: string;
  name: string;
  currencyCode: string;
  defaultPriceMinor: bigint;
  defaultCostMinor: bigint;
  lowStockThreshold: string | null;
  isActive: boolean;
  createdAt: Date;
};

function toDomain(row: ProductReadRow): Product {
  return {
    id: row.id,
    structureId: row.structureId,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    unitId: row.unitId,
    sku: row.sku,
    name: row.name,
    currencyCode: row.currencyCode,
    defaultPriceMinor: row.defaultPriceMinor,
    defaultCostMinor: row.defaultCostMinor,
    lowStockThreshold: row.lowStockThreshold,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

// Single-row write paths (insert/update/setActive) only get a `products`
// row back from `.returning()` -- no join. A single extra lookup here is
// NOT an N+1 (there is exactly one row being written), unlike a per-row
// lookup inside `list()` would be.
async function fetchCategoryName(
  ctx: TenantSessionContext,
  categoryId: string | null
): Promise<string | null> {
  if (!categoryId) {
    return null;
  }
  const [row] = await ctx.db
    .select({ name: productCategories.name })
    .from(productCategories)
    .where(and(eq(productCategories.structureId, ctx.actor.structureId), eq(productCategories.id, categoryId)))
    .limit(1);
  return row?.name ?? null;
}

function withCategoryJoin(ctx: TenantSessionContext) {
  return ctx.db
    .select(PRODUCT_READ_COLUMNS)
    .from(products)
    .leftJoin(
      productCategories,
      and(eq(productCategories.structureId, products.structureId), eq(productCategories.id, products.categoryId))
    );
}

export const productRepository: ProductRepository = {
  async findById(ctx: TenantSessionContext, productId: string): Promise<Product | null> {
    const [row] = await withCategoryJoin(ctx)
      .where(and(eq(products.structureId, ctx.actor.structureId), eq(products.id, productId)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async findBySku(ctx: TenantSessionContext, sku: string): Promise<Product | null> {
    const [row] = await withCategoryJoin(ctx)
      .where(and(eq(products.structureId, ctx.actor.structureId), eq(products.sku, sku)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async list(ctx: TenantSessionContext, filter: ListProductsFilter): Promise<Product[]> {
    const conditions = [eq(products.structureId, ctx.actor.structureId)];
    if (filter.activeOnly) {
      conditions.push(eq(products.isActive, true));
    }
    if (filter.categoryId) {
      conditions.push(eq(products.categoryId, filter.categoryId));
    }
    if (filter.search && filter.search.trim().length > 0) {
      const term = `%${filter.search.trim()}%`;
      const searchCondition = or(ilike(products.name, term), ilike(products.sku, term));
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }
    const rows = await withCategoryJoin(ctx).where(and(...conditions));
    return rows.map(toDomain);
  },

  async insert(ctx: TenantSessionContext, input: CreateProductInput): Promise<Product> {
    const [row] = await ctx.db
      .insert(products)
      .values({
        structureId: ctx.actor.structureId,
        sku: input.sku,
        name: input.name,
        unitId: input.unitId,
        categoryId: input.categoryId ?? null,
        currencyCode: input.currencyCode,
        defaultPriceMinor: input.defaultPriceMinor,
        defaultCostMinor: input.defaultCostMinor,
        lowStockThreshold: input.lowStockThreshold ?? null,
      })
      .returning();
    const categoryName = await fetchCategoryName(ctx, row.categoryId);
    return toDomain({ ...row, categoryName });
  },

  async update(
    ctx: TenantSessionContext,
    productId: string,
    input: UpdateProductInput
  ): Promise<Product> {
    const patch: Partial<typeof products.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.unitId !== undefined) patch.unitId = input.unitId;
    if (input.defaultPriceMinor !== undefined) patch.defaultPriceMinor = input.defaultPriceMinor;
    if (input.defaultCostMinor !== undefined) patch.defaultCostMinor = input.defaultCostMinor;
    if (input.lowStockThreshold !== undefined) patch.lowStockThreshold = input.lowStockThreshold;

    const [row] = await ctx.db
      .update(products)
      .set(patch)
      .where(and(eq(products.structureId, ctx.actor.structureId), eq(products.id, productId)))
      .returning();
    const categoryName = await fetchCategoryName(ctx, row.categoryId);
    return toDomain({ ...row, categoryName });
  },

  async setActive(ctx: TenantSessionContext, productId: string, isActive: boolean): Promise<Product> {
    const [row] = await ctx.db
      .update(products)
      .set({ isActive })
      .where(and(eq(products.structureId, ctx.actor.structureId), eq(products.id, productId)))
      .returning();
    const categoryName = await fetchCategoryName(ctx, row.categoryId);
    return toDomain({ ...row, categoryName });
  },

  async assignCategory(
    ctx: TenantSessionContext,
    productIds: string[],
    categoryId: string | null
  ): Promise<number> {
    if (productIds.length === 0) {
      return 0;
    }
    const rows = await ctx.db
      .update(products)
      .set({ categoryId })
      .where(and(eq(products.structureId, ctx.actor.structureId), inArray(products.id, productIds)))
      .returning({ id: products.id });
    return rows.length;
  },
};
