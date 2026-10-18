// Pure domain entity + pure logic for product categories ("rayons"). No
// drizzle, no Next imports -- see docs/platform.md's layering rule. A
// category is a navigation grouping only (D-decision for this feature: NOT
// a composite/bundle product); each `Product` keeps its own price and is
// sold individually regardless of which category it sits in.
export interface Category {
  id: string;
  structureId: string;
  parentId: string | null;
  name: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// wouldCreateCycle -- pure, DB-free cycle guard for reparenting.
//
// The self-FK on `product_categories` (structure_id, parent_id) ->
// (structure_id, id) only guarantees "this parent row exists in my tenant".
// It cannot see "is this parent actually a descendant of the category being
// moved", which is exactly what would create a cycle (a category becoming
// its own ancestor). This function walks the parent chain from
// `newParentId` upward against a snapshot of every category in the tenant
// and reports whether `categoryId` appears anywhere in that chain -- or is
// the new parent itself.
// ---------------------------------------------------------------------------
export function wouldCreateCycle(
  categories: ReadonlyArray<{ id: string; parentId: string | null }>,
  categoryId: string,
  newParentId: string
): boolean {
  if (newParentId === categoryId) {
    return true; // a category can never be its own parent
  }

  const byId = new Map(categories.map((c) => [c.id, c]));
  const visited = new Set<string>(); // guards against a pre-existing, unrelated cycle in the snapshot
  let current: string | null = newParentId;

  while (current) {
    if (current === categoryId) {
      return true;
    }
    if (visited.has(current)) {
      return false; // already-corrupt data upstream, not a cycle this move introduces
    }
    visited.add(current);
    current = byId.get(current)?.parentId ?? null;
  }

  return false;
}

// ---------------------------------------------------------------------------
// isDuplicateCategoryName -- pure, exact (never ILIKE/wildcard) case-
// insensitive comparison. Same bug class as the M1 fix in
// customer-repository.ts: free-text input containing `%`/`_` must never be
// treated as a pattern. This only ever compares full strings.
// ---------------------------------------------------------------------------
export function isDuplicateCategoryName(
  siblingNames: ReadonlyArray<string>,
  candidateName: string
): boolean {
  const normalized = candidateName.trim().toLowerCase();
  return siblingNames.some((name) => name.trim().toLowerCase() === normalized);
}
