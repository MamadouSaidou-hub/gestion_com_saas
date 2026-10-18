import type { membershipRoleEnum } from "@/db/schema/tenancy";

// Drizzle pgEnum doesn't export a plain string-union type directly; derive it
// from the enum's own `.enumValues` tuple so this stays in sync with the DB
// schema automatically if a role is ever added/removed there.
export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];

// The ONLY object that carries tenant context through the app. Always
// produced by resolveActor() after a real DB check against `memberships` --
// never constructed by hand from a client-supplied structureId/role.
export interface Actor {
  userId: string;
  structureId: string;
  role: MembershipRole;
}
