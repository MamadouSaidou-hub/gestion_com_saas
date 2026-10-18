import { and, count, eq, isNull } from "drizzle-orm";
import { productCategories, products } from "@/db/schema/catalog";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { Category } from "../domain/category";
import type {
  CategoryRepository,
  CategorySiblingRecord,
  CreateCategoryInput,
  UpdateCategoryInput,
} from "../application/ports";

// Drizzle implementation of the CategoryRepository port. Together with
// product-repository.ts, this is the ONLY file in the catalog module
// allowed to import `@/db/schema/catalog` (enforced by the ESLint layering
// rule).

type CategoryRow = typeof productCategories.$inferSelect;

function toDomain(row: CategoryRow): Category {
  return {
    id: row.id,
    structureId: row.structureId,
    parentId: row.parentId,
    name: row.name,
    createdAt: row.createdAt,
  };
}

export const categoryRepository: CategoryRepository = {
  async findById(ctx: TenantSessionContext, categoryId: string): Promise<Category | null> {
    const [row] = await ctx.db
      .select()
      .from(productCategories)
      .where(
        and(eq(productCategories.structureId, ctx.actor.structureId), eq(productCategories.id, categoryId))
      )
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async list(ctx: TenantSessionContext): Promise<Category[]> {
    const rows = await ctx.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.structureId, ctx.actor.structureId))
      .orderBy(productCategories.name);
    return rows.map(toDomain);
  },

  async listByParent(
    ctx: TenantSessionContext,
    parentId: string | null
  ): Promise<CategorySiblingRecord[]> {
    const parentCondition =
      parentId === null ? isNull(productCategories.parentId) : eq(productCategories.parentId, parentId);
    const rows = await ctx.db
      .select({ id: productCategories.id, name: productCategories.name })
      .from(productCategories)
      .where(and(eq(productCategories.structureId, ctx.actor.structureId), parentCondition));
    return rows;
  },

  async insert(ctx: TenantSessionContext, input: CreateCategoryInput): Promise<Category> {
    const [row] = await ctx.db
      .insert(productCategories)
      .values({
        structureId: ctx.actor.structureId,
        name: input.name,
        parentId: input.parentId,
      })
      .returning();
    return toDomain(row);
  },

  async update(
    ctx: TenantSessionContext,
    categoryId: string,
    input: UpdateCategoryInput
  ): Promise<Category> {
    const patch: Partial<typeof productCategories.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.parentId !== undefined) patch.parentId = input.parentId;

    const [row] = await ctx.db
      .update(productCategories)
      .set(patch)
      .where(
        and(eq(productCategories.structureId, ctx.actor.structureId), eq(productCategories.id, categoryId))
      )
      .returning();
    return toDomain(row);
  },

  async delete(ctx: TenantSessionContext, categoryId: string): Promise<void> {
    await ctx.db
      .delete(productCategories)
      .where(
        and(eq(productCategories.structureId, ctx.actor.structureId), eq(productCategories.id, categoryId))
      );
  },

  async countProducts(ctx: TenantSessionContext, categoryId: string): Promise<number> {
    const [row] = await ctx.db
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.structureId, ctx.actor.structureId), eq(products.categoryId, categoryId)));
    return row?.value ?? 0;
  },

  async countChildren(ctx: TenantSessionContext, categoryId: string): Promise<number> {
    const [row] = await ctx.db
      .select({ value: count() })
      .from(productCategories)
      .where(
        and(
          eq(productCategories.structureId, ctx.actor.structureId),
          eq(productCategories.parentId, categoryId)
        )
      );
    return row?.value ?? 0;
  },
};
