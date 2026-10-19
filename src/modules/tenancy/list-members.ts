import { eq, inArray, and } from "drizzle-orm";
import { memberships } from "@/db/schema/tenancy";
import { warehouses } from "@/db/schema/catalog";
import { user as identityUser } from "@/modules/identity/schema";
import { can } from "./permissions";
import { ForbiddenError } from "@/platform/errors";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { MembershipRole } from "./types";

// ---------------------------------------------------------------------------
// listMembers -- the real query /parametres/equipe was missing entirely
// (it rendered mock-team.ts). Reads `memberships` (tenant-scoped, under RLS
// via ctx.db -- same transaction withTenantSession already opened) and
// JOINS in each member's display name/email from Better Auth's own `user`
// table (identity module). That table has no tenant dimension/RLS (see
// modules/identity/schema.ts) and app_user already holds SELECT on it
// (0000_identity_core.sql) -- reading it from the SAME Postgres transaction
// is just a second `select` against a different schema object, not a
// second connection or a cross-tenant leak (the IN-list below is built
// entirely from `memberships.user_id` values already scoped to THIS
// structure by RLS).
//
// Gated the same way the page itself is (settings:write OR audit:read) --
// enforced again here, not just at the page boundary, because this is now
// a real use case other callers could reach directly.
// ---------------------------------------------------------------------------

export interface MemberListItem {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  status: "active" | "invited" | "suspended";
  warehouseId: string | null;
  warehouseName: string | null;
  joinedOn: string; // ISO date, DTO boundary (timestamp -> string)
  mustChangePassword: boolean;
}

export async function listMembers(ctx: TenantSessionContext): Promise<MemberListItem[]> {
  if (!canViewTeam(ctx)) {
    throw new ForbiddenError("Role does not have permission to view the team roster.");
  }

  const rows = await ctx.db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      status: memberships.status,
      warehouseId: memberships.warehouseId,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .where(eq(memberships.structureId, ctx.actor.structureId));

  if (rows.length === 0) {
    return [];
  }

  const userIds = rows.map((r) => r.userId);
  const warehouseIds = [...new Set(rows.map((r) => r.warehouseId).filter((id): id is string => id !== null))];

  const [users, stores] = await Promise.all([
    ctx.db
      .select({ id: identityUser.id, name: identityUser.name, email: identityUser.email, mustChangePassword: identityUser.mustChangePassword })
      .from(identityUser)
      .where(inArray(identityUser.id, userIds)),
    warehouseIds.length > 0
      ? ctx.db
          .select({ id: warehouses.id, name: warehouses.name })
          .from(warehouses)
          .where(and(eq(warehouses.structureId, ctx.actor.structureId), inArray(warehouses.id, warehouseIds)))
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const warehouseById = new Map(stores.map((w) => [w.id, w.name]));

  return rows.map((row) => {
    const identity = userById.get(row.userId);
    return {
      userId: row.userId,
      name: identity?.name ?? "(compte supprimé)",
      email: identity?.email ?? "",
      role: row.role,
      status: row.status,
      warehouseId: row.warehouseId,
      warehouseName: row.warehouseId ? warehouseById.get(row.warehouseId) ?? null : null,
      joinedOn: row.createdAt.toISOString(),
      mustChangePassword: identity?.mustChangePassword ?? false,
    };
  });
}

// Shared with create-member.ts/change-member-role.ts/suspend-member.ts so
// "who may see/manage the roster" stays defined in exactly one place.
export function canViewTeam(ctx: TenantSessionContext): boolean {
  return can(ctx.actor, "settings:write") || can(ctx.actor, "audit:read");
}
