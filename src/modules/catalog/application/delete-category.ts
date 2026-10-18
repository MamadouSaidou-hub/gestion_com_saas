import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { CategoryHasDependentsError, CategoryNotFoundError } from "../domain/errors";
import type { CategoryRepository } from "./ports";

// Hard delete, but BLOCKED while anything still references the category --
// never a silent "null out every product's category_id" on delete. A
// shopkeeper who deletes "Petit dejeuner" expects to be told it still
// groups 8 products (and asked to move them first), not to discover later
// that those 8 products silently fell into "no rayon" with no visible
// cause. This also sidesteps the composite FKs on `products.category_id`
// and `product_categories.parent_id` (both NO ACTION) ever raising a raw
// constraint violation -- the count is always checked and reported first.
export async function deleteCategory(
  ctx: TenantSessionContext,
  categoryId: string,
  repo: CategoryRepository
): Promise<void> {
  assertCan(ctx.actor, "category:write");

  const existing = await repo.findById(ctx, categoryId);
  if (!existing) {
    throw new CategoryNotFoundError(categoryId);
  }

  const [productCount, childCount] = await Promise.all([
    repo.countProducts(ctx, categoryId),
    repo.countChildren(ctx, categoryId),
  ]);

  if (productCount > 0 || childCount > 0) {
    throw new CategoryHasDependentsError(categoryId, productCount, childCount);
  }

  await repo.delete(ctx, categoryId);

  await ctx.audit.append({
    action: "category.deleted",
    targetType: "category",
    targetId: categoryId,
    payload: {},
  });
}
