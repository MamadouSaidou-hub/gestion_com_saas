import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { CategoryNotFoundError, InvalidProductInputError } from "../domain/errors";
import type { CategoryRepository, ProductRepository } from "./ports";

export interface AssignProductsToCategoryRequest {
  // `null` is a valid, meaningful input: "remove these products from
  // whatever category they're currently in" (back to "Sans rayon" in the
  // UI's terms).
  categoryId: string | null;
  productIds: string[];
}

export interface AssignProductsToCategoryResult {
  updatedCount: number;
}

// Bulk, single-transaction reassignment -- the use case that makes "select
// 8 products -> put them all in Petit dejeuner" a single call instead of a
// client-side loop over `updateProduct`. Deduplicates its input and reports
// how many rows actually matched this tenant (silently excludes ids that
// don't exist or belong to another tenant, same semantics as every other
// tenant-scoped repository call in this module).
export async function assignProductsToCategory(
  ctx: TenantSessionContext,
  input: AssignProductsToCategoryRequest,
  productRepo: ProductRepository,
  categoryRepo: CategoryRepository
): Promise<AssignProductsToCategoryResult> {
  assertCan(ctx.actor, "category:write");

  const productIds = Array.from(new Set(input.productIds));
  if (productIds.length === 0) {
    throw new InvalidProductInputError("At least one product id is required.");
  }

  if (input.categoryId !== null) {
    const category = await categoryRepo.findById(ctx, input.categoryId);
    if (!category) {
      throw new CategoryNotFoundError(input.categoryId);
    }
  }

  const updatedCount = await productRepo.assignCategory(ctx, productIds, input.categoryId);

  // ids only -- no PII, no amounts. `targetId` is a `uuid` column at the
  // DB level (cast via `::uuid` in audit_log_append) -- `null` (not a
  // string sentinel like "none") is how "removed from any category" is
  // represented when `categoryId` itself is null.
  await ctx.audit.append({
    action: "product.category_assigned",
    targetType: "category",
    targetId: input.categoryId,
    payload: { categoryId: input.categoryId, productIds, updatedCount },
  });

  return { updatedCount };
}
