import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { memberships } from "@/db/schema/tenancy";
import { assertCan } from "./permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { MembershipRole } from "./types";

// ---------------------------------------------------------------------------
// changeMemberRole -- promote/demote a teammate on /parametres/equipe.
// Gated on "settings:write" (owner + manager both hold it, matching the
// page's own visibility gate), with the owner-escalation/owner-row guard
// rails encoded explicitly here -- same pattern as assign-member-
// warehouse.ts/create-member.ts, not inferred from the permission alone:
//   - a non-owner may never touch a row that currently IS "owner" (demote,
//     or any other role change on that row).
//   - a non-owner may never promote anyone TO "owner".
//   - the DB's owner-lockout trigger (0003) is the terminal guard against
//     demoting the LAST active owner -- caught below and mapped to a clean
//     error instead of a raw Postgres exception message.
// RLS (memberships_update, 0004/0006) independently re-checks the first
// two rules -- defense in depth, not the only gate.
// ---------------------------------------------------------------------------

export class CannotTargetOwnerRowError extends Error {
  constructor() {
    super('Only an "owner" may change another "owner"\'s role.');
    this.name = "CannotTargetOwnerRowError";
  }
}

export class CannotPromoteToOwnerError extends Error {
  constructor() {
    super('Only an "owner" may promote a member to "owner".');
    this.name = "CannotPromoteToOwnerError";
  }
}

export class CannotChangeOwnRoleError extends Error {
  constructor() {
    super("You cannot change your own role.");
    this.name = "CannotChangeOwnRoleError";
  }
}

export class MemberNotFoundError extends Error {
  constructor(userId: string) {
    super(`No active membership found for user "${userId}" in this structure.`);
    this.name = "MemberNotFoundError";
  }
}

export class LastOwnerGuardError extends Error {
  constructor() {
    super("This is the last active owner of this structure -- it cannot be demoted.");
    this.name = "LastOwnerGuardError";
  }
}

const inputSchema = z.object({
  memberUserId: z.string().trim().min(1),
  newRole: z.enum(["owner", "manager", "cashier", "stock_keeper", "accountant", "auditor"]),
});

export interface ChangeMemberRoleInput {
  memberUserId: string;
  newRole: MembershipRole;
}

export async function changeMemberRole(
  ctx: TenantSessionContext,
  rawInput: ChangeMemberRoleInput
): Promise<void> {
  assertCan(ctx.actor, "settings:write");
  const input = inputSchema.parse(rawInput);

  if (input.memberUserId === ctx.actor.userId) {
    throw new CannotChangeOwnRoleError();
  }

  const [target] = await ctx.db
    .select({ role: memberships.role, warehouseId: memberships.warehouseId })
    .from(memberships)
    .where(
      and(
        eq(memberships.structureId, ctx.actor.structureId),
        eq(memberships.userId, input.memberUserId),
        eq(memberships.status, "active")
      )
    )
    .limit(1);
  if (!target) {
    throw new MemberNotFoundError(input.memberUserId);
  }

  if (ctx.actor.role !== "owner") {
    if (target.role === "owner") {
      throw new CannotTargetOwnerRowError();
    }
    if (input.newRole === "owner") {
      throw new CannotPromoteToOwnerError();
    }
  }

  // Promoting to owner also clears store scope (owner can never be
  // store-scoped, same CHECK as assign-member-warehouse.ts).
  const nextWarehouseId = input.newRole === "owner" ? null : target.warehouseId;

  try {
    await ctx.db
      .update(memberships)
      .set({ role: input.newRole, warehouseId: nextWarehouseId })
      .where(and(eq(memberships.structureId, ctx.actor.structureId), eq(memberships.userId, input.memberUserId)));
  } catch (err) {
    if (err instanceof Error && err.message.includes("cannot remove/demote the last active owner")) {
      throw new LastOwnerGuardError();
    }
    throw err;
  }

  await ctx.audit.append({
    action: "member.role_changed",
    targetType: "membership",
    // targetId is a uuid column (audit_log_append's own signature, 0001) --
    // Better Auth's own user id is NOT guaranteed to be uuid-shaped (its
    // default generator produces a plain random string, see
    // modules/identity/schema.ts), so it must never be cast into that
    // column. Carried in the payload instead, under a non-PII key name.
    targetId: null,
    payload: { memberUserId: input.memberUserId, previousRole: target.role, newRole: input.newRole },
  });
}
