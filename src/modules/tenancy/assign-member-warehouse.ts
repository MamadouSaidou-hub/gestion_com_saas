import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { memberships } from "@/db/schema/tenancy";
import { warehouses } from "@/db/schema/catalog";
import { ForbiddenError } from "@/platform/errors";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";

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
    targetId: input.memberUserId,
    payload: { warehouseId: input.warehouseId, previousWarehouseId: target.warehouseId },
  });
}
