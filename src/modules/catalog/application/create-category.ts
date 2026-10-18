import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { isDuplicateCategoryName } from "../domain/category";
import {
  DuplicateCategoryNameError,
  InvalidCategoryParentError,
  InvalidProductInputError,
} from "../domain/errors";
import type { CategoryRepository } from "./ports";
import type { CategoryDto } from "./dto";
import { toCategoryDto } from "./mappers";

export interface CreateCategoryRequest {
  name: string;
  parentId?: string | null;
}

export async function createCategory(
  ctx: TenantSessionContext,
  input: CreateCategoryRequest,
  repo: CategoryRepository
): Promise<CategoryDto> {
  assertCan(ctx.actor, "category:write");

  const name = input.name.trim();
  if (name.length === 0) {
    throw new InvalidProductInputError("Category name is required.");
  }
  const parentId = input.parentId ?? null;

  if (parentId) {
    // Tenant-scoped lookup -- fails cleanly (typed error) whether the
    // parent simply doesn't exist or belongs to another tenant, instead of
    // letting the composite self-FK raise a raw constraint violation.
    const parent = await repo.findById(ctx, parentId);
    if (!parent) {
      throw new InvalidCategoryParentError(parentId);
    }
  }

  // Exact, case-insensitive sibling check (never ILIKE/wildcard -- see
  // isDuplicateCategoryName's doc comment) so a shop never ends up with two
  // "Boissons" at the same level.
  const siblings = await repo.listByParent(ctx, parentId);
  if (isDuplicateCategoryName(siblings.map((s) => s.name), name)) {
    throw new DuplicateCategoryNameError(name);
  }

  const category = await repo.insert(ctx, { name, parentId });

  // ids only -- no PII, no amounts to log here.
  await ctx.audit.append({
    action: "category.created",
    targetType: "category",
    targetId: category.id,
    payload: { parentId },
  });

  return toCategoryDto(category);
}
