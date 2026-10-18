import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { CustomerRepository } from "./ports";

// Ctx-based primitive -- called by sales' confirmSaleAction while
// resolving a POS-entered customer NAME into a real `customerId` before
// calling confirmSale, which already gates on `sale:create`. There is no
// dedicated customers module yet (out of this phase's scope); this is the
// minimal primitive another module needs, owned here since `customers` is
// catalog's table.
//
// M2 fix (security-reviewer, Medium): `assertCan` is now this function's
// FIRST line (it was missing -- the convention everywhere else in this
// codebase, including inventory's applyStockOut, is that a ctx-based
// primitive with NO independent permission check is only safe when the
// caller's own check already covers it; `actions.ts` calls this BEFORE
// `confirmSale`'s `sale:create` check, so without its own gate this
// function would run writes before any permission was verified at all --
// not currently exploitable, since confirmSale's later throw rolls the
// whole transaction back, but it was the one real breach of the
// convention).
export async function findOrCreateCustomerByName(
  ctx: TenantSessionContext,
  name: string,
  repo: CustomerRepository
): Promise<string> {
  assertCan(ctx.actor, "customer:write");
  const trimmed = name.trim();
  const existing = await repo.findByName(ctx, trimmed);
  if (existing) {
    return existing.id;
  }
  const created = await repo.insert(ctx, { name: trimmed });
  return created.id;
}
