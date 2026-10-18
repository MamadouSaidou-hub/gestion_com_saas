import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { isDuplicateCategoryName, wouldCreateCycle } from "../domain/category";
import {
  CategoryCycleError,
  CategoryNotFoundError,
  DuplicateCategoryNameError,
  InvalidCategoryParentError,
  InvalidProductInputError,
} from "../domain/errors";
import type { CategoryRepository } from "./ports";
import type { CategoryDto } from "./dto";
import { toCategoryDto } from "./mappers";

export interface UpdateCategoryRequest {
  id: string;
  name?: string;
  parentId?: string | null;
}

export async function updateCategory(
  ctx: TenantSessionContext,
  input: UpdateCategoryRequest,
  repo: CategoryRepository
): Promise<CategoryDto> {
  assertCan(ctx.actor, "category:write");

  const existing = await repo.findById(ctx, input.id);
  if (!existing) {
    throw new CategoryNotFoundError(input.id);
  }

  const name = input.name !== undefined ? input.name.trim() : undefined;
  if (name !== undefined && name.length === 0) {
    throw new InvalidProductInputError("Category name is required.");
  }

  const reparenting = input.parentId !== undefined && input.parentId !== existing.parentId;
  const nextParentId = input.parentId !== undefined ? input.parentId : existing.parentId;

  if (reparenting && nextParentId !== null) {
    const parent = await repo.findById(ctx, nextParentId);
    if (!parent) {
      throw new InvalidCategoryParentError(nextParentId);
    }

    // Cycle guard: the self-FK only validates "this parent row exists in my
    // tenant", never "is this parent actually one of my own descendants" --
    // that's exactly what reparenting under your own subtree would be.
    // Pure, DB-free check against a full snapshot (also unit-tested
    // directly, no DB needed).
    const allCategories = await repo.list(ctx);
    if (wouldCreateCycle(allCategories, input.id, nextParentId)) {
      throw new CategoryCycleError(input.id, nextParentId);
    }
  }

  if (name !== undefined || reparenting) {
    const effectiveName = name ?? existing.name;
    const siblings = await repo.listByParent(ctx, nextParentId);
    const siblingNames = siblings.filter((s) => s.id !== input.id).map((s) => s.name);
    if (isDuplicateCategoryName(siblingNames, effectiveName)) {
      throw new DuplicateCategoryNameError(effectiveName);
    }
  }

  const category = await repo.update(ctx, input.id, {
    name,
    parentId: input.parentId,
  });

  await ctx.audit.append({
    action: "category.updated",
    targetType: "category",
    targetId: category.id,
    payload: { parentId: category.parentId },
  });

  return toCategoryDto(category);
}
