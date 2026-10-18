import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { CategoryRepository } from "./ports";
import type { CategoryDto } from "./dto";
import { toCategoryDto } from "./mappers";

// Gated on `product:read` rather than a dedicated `category:read` --
// deliberate reuse (see docs/platform.md's permission-matrix note): every
// role that can see products can see the rayons they're grouped into, and
// no role in the current matrix has `category:write` without also having
// `product:read`. Revisit with a real `category:read` permission only if a
// future role needs to see categories without seeing products (or
// vice-versa).
//
// Returns a FLAT list, each item carrying its own `parentId` -- NOT a
// nested tree. A brand-new shop gets `[]` (no categories yet is a normal,
// not-an-error state). The designer/UI is expected to build whatever tree/
// breadcrumb it needs client-side from this flat shape (it's also exactly
// the snapshot `wouldCreateCycle` walks server-side, so the two stay
// consistent by construction).
export async function listCategories(
  ctx: TenantSessionContext,
  repo: CategoryRepository
): Promise<CategoryDto[]> {
  assertCan(ctx.actor, "product:read");
  const categories = await repo.list(ctx);
  return categories.map(toCategoryDto);
}
