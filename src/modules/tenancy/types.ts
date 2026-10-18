import type { membershipRoleEnum } from "@/db/schema/tenancy";

// Drizzle pgEnum doesn't export a plain string-union type directly; derive it
// from the enum's own `.enumValues` tuple so this stays in sync with the DB
// schema automatically if a role is ever added/removed there.
export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];

// The ONLY object that carries tenant context through the app. Always
// produced by resolveActor() after a real DB check against `memberships` --
// never constructed by hand from a client-supplied structureId/role.
//
// `warehouseId` (migration 0014 / multi-store) -- the member's STORE SCOPE,
// read from the SAME `memberships` row as `role`, in the SAME SQL round
// trip resolveActor() already does. NULL means "all stores" (always true
// for `owner`, enforced by a DB CHECK; may also be true for any other role
// left unscoped). A non-null value means this actor is a "gerant": a
// `manager` (or any other role) pinned to exactly one store. This is a
// SEPARATE axis from `scopeFor('own'|'all')` (tenancy/permissions.ts) --
// never conflate "which rows of MY data can I see" with "which STORE am I
// restricted to" even though both end up filtering the same tables.
export interface Actor {
  userId: string;
  structureId: string;
  role: MembershipRole;
  warehouseId: string | null;
}
