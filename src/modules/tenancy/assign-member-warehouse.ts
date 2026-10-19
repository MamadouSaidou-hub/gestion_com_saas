import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { memberships } from "@/db/schema/tenancy";
import { warehouses } from "@/db/schema/catalog";
import { ForbiddenError } from "@/platform/errors";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { assertCan } from "./permissions";

// ---------------------------------------------------------------------------
// assignMemberWarehouse -- "assigning a store to an existing member" on
// /parametres/equipe (multi-store, migration 0014). Owner-only, same
// rationale as every other membership-mutating action in this codebase
// (role changes, invites) -- encoded here as an explicit role check
// because tenancy owns `permissions.ts` itself (no separate "team" module
// exists yet, per docs/platform.md's "known gaps" list), not because this
// is a lesser control than `assertCan`.
//
// `warehouseId: null` UNSCOPES a member (gives them all-stores visibility)
// -- this is how an owner demotes a gerant back to a regular manager, or
// fixes a membership left pointing at an archived store. The DB CHECK
// added by migration 0014 (`role = 'owner' => warehouse_id is null`) is
// the real floor here: this function's OWN pre-check below exists so a
// non-owner target gets a clear, typed error instead of a raw constraint
// violation, and so an attempt to store-scope an OWNER target is rejected
// with the same clarity.
// ---------------------------------------------------------------------------

export class MemberNotFoundError extends Error {
  constructor(userId: string) {
    super(`No active membership found for user "${userId}" in this structure.`);
    this.name = "MemberNotFoundError";
  }
}

export class CannotScopeOwnerToStoreError extends Error {
  constructor() {
    super('An "owner" membership can never be scoped to a single store.');
    this.name = "CannotScopeOwnerToStoreError";
  }
}

export class WarehouseNotFoundForAssignmentError extends Error {
  constructor(warehouseId: string) {
    super(`Warehouse "${warehouseId}" was not found in this structure.`);
    this.name = "WarehouseNotFoundForAssignmentError";
  }
}

const inputSchema = z.object({
  memberUserId: z.string().trim().min(1),
  warehouseId: z.uuid().nullable(),
});

export interface AssignMemberWarehouseInput {
  memberUserId: string;
  warehouseId: string | null;
}

export async function assignMemberWarehouse(
  ctx: TenantSessionContext,
  rawInput: AssignMemberWarehouseInput
): Promise<void> {
  // assertCan first (convention, docs/platform.md) -- the explicit
  // role !== "owner" check right below is kept as defense in depth: today
  // "member:scope_set" is only ever granted to owner (permissions.ts), so
  // the two checks currently agree, but this function predates the
  // permission (it used to be the ONLY gate) and the matrix is the kind of
  // file that drifts over time -- keep both rather than trust one.
  assertCan(ctx.actor, "member:scope_set");
  if (ctx.actor.role !== "owner") {
    throw new ForbiddenError('Only an "owner" may assign a member to a store.');
  }
  const input = inputSchema.parse(rawInput);

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
  if (target.role === "owner" && input.warehouseId !== null) {
    throw new CannotScopeOwnerToStoreError();
  }

  if (input.warehouseId !== null) {
    const [warehouse] = await ctx.db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.structureId, ctx.actor.structureId), eq(warehouses.id, input.warehouseId)))
      .limit(1);
    if (!warehouse) {
      throw new WarehouseNotFoundForAssignmentError(input.warehouseId);
    }
  }

  await ctx.db
    .update(memberships)
    .set({ warehouseId: input.warehouseId })
    .where(
      and(
        eq(memberships.structureId, ctx.actor.structureId),
        eq(memberships.userId, input.memberUserId)
      )
    );

  await ctx.audit.append({
    action: "membership.warehouse_assigned",
    targetType: "membership",
    // H-fix (found while wiring this control to the real UI, team/
    // user-creation phase): `targetId` is a uuid column (audit_log_append,
    // 0001) -- Better Auth's own user id is NOT guaranteed uuid-shaped (its
    // default generator produces a plain random string, see
    // modules/identity/schema.ts), so casting it into this column would
    // throw `invalid input syntax for type uuid` for any real signed-up
    // user. This function predates the real UI wiring and was never
    // exercised with a real Better Auth id before -- caught by execution
    // while adding create-member.integration.test.ts's coverage for
    // change-member-role.ts/suspend-member.ts, which share the same
    // pattern. Carried in the payload instead, under a non-PII key name.
    targetId: null,
    payload: { memberUserId: input.memberUserId, warehouseId: input.warehouseId, previousWarehouseId: target.warehouseId },
  });
}
