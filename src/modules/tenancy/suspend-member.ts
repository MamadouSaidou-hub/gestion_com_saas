import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { memberships } from "@/db/schema/tenancy";
import { assertCan } from "./permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// setMemberSuspended -- suspend/reactivate a teammate on /parametres/equipe.
// Gated on "member:remove" (owner-only in the matrix, unchanged, matching
// the existing "removing a teammate stays owner-only" convention) -- a
// suspension is the "soft" version of removal (status flip, not a DELETE,
// so the membership row and its audit history survive), reusing the same
// permission rather than adding a new one, since the two actions sit at
// the exact same trust tier and the task's permission list deliberately
// does not add a dedicated one for this.
//
// The DB's owner-lockout trigger (0003) already blocks suspending the last
// active owner (status moving away from 'active' is one of its guarded
// transitions) -- caught below and mapped to a clean error, same pattern as
// change-member-role.ts.
// ---------------------------------------------------------------------------

export class CannotSuspendSelfError extends Error {
  constructor() {
    super("You cannot suspend your own membership.");
    this.name = "CannotSuspendSelfError";
  }
}

export class MemberNotFoundError extends Error {
  constructor(userId: string) {
    super(`No membership found for user "${userId}" in this structure.`);
    this.name = "MemberNotFoundError";
  }
}

export class LastOwnerGuardError extends Error {
  constructor() {
    super("This is the last active owner of this structure -- it cannot be suspended.");
    this.name = "LastOwnerGuardError";
  }
}

const inputSchema = z.object({
  memberUserId: z.string().trim().min(1),
  suspended: z.boolean(),
});

export interface SetMemberSuspendedInput {
  memberUserId: string;
  suspended: boolean;
}

export async function setMemberSuspended(
  ctx: TenantSessionContext,
  rawInput: SetMemberSuspendedInput
): Promise<void> {
  assertCan(ctx.actor, "member:remove");
  const input = inputSchema.parse(rawInput);

  if (input.memberUserId === ctx.actor.userId) {
    throw new CannotSuspendSelfError();
  }

  const [target] = await ctx.db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.structureId, ctx.actor.structureId), eq(memberships.userId, input.memberUserId)))
    .limit(1);
  if (!target) {
    throw new MemberNotFoundError(input.memberUserId);
  }

  const nextStatus = input.suspended ? "suspended" : "active";

  try {
    await ctx.db
      .update(memberships)
      .set({ status: nextStatus })
      .where(and(eq(memberships.structureId, ctx.actor.structureId), eq(memberships.userId, input.memberUserId)));
  } catch (err) {
    if (err instanceof Error && err.message.includes("cannot remove/demote the last active owner")) {
      throw new LastOwnerGuardError();
    }
    throw err;
  }

  await ctx.audit.append({
    action: input.suspended ? "member.suspended" : "member.reactivated",
    targetType: "membership",
    // See change-member-role.ts's comment: Better Auth's user id is not
    // guaranteed uuid-shaped, so it never goes into the uuid `targetId`
    // column -- carried in the payload instead.
    targetId: null,
    payload: { memberUserId: input.memberUserId, previousStatus: target.status, newStatus: nextStatus },
  });
}
