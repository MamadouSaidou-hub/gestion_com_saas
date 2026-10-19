"use server";

import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { assignMemberWarehouse } from "@/modules/tenancy/assign-member-warehouse";
import { listMembers, type MemberListItem } from "@/modules/tenancy/list-members";
import { createMember, EmailAlreadyExistsError, CannotCreateOwnerError, OwnerCannotBeStoreScopedError, WarehouseNotFoundError } from "@/modules/tenancy/create-member";
import {
  changeMemberRole,
  CannotTargetOwnerRowError,
  CannotPromoteToOwnerError,
  CannotChangeOwnRoleError,
  LastOwnerGuardError as RoleChangeLastOwnerGuardError,
  MemberNotFoundError as RoleChangeMemberNotFoundError,
} from "@/modules/tenancy/change-member-role";
import {
  setMemberSuspended,
  CannotSuspendSelfError,
  LastOwnerGuardError as SuspendLastOwnerGuardError,
  MemberNotFoundError as SuspendMemberNotFoundError,
} from "@/modules/tenancy/suspend-member";
import { UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { dict } from "@/lib/i18n";
import type { MembershipRole } from "@/modules/tenancy/types";

// ---------------------------------------------------------------------------
// /parametres/equipe server actions. Every action follows the documented
// chain (docs/platform.md): getSession -> resolveActor -> withTenantSession
// -> use case (which runs its own assertCan first). Errors coming out of
// the DB's own guard rails (RLS denial, the owner-lockout trigger) are
// mapped to clean, typed results here -- never a raw constraint/RLS error
// string reaching the UI.
// ---------------------------------------------------------------------------

export type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string };

function unauthenticatedResult(): { ok: false; message: string } {
  return { ok: false, message: "Session expirée. Reconnectez-vous." };
}

export async function listMembersAction(structureId: string): Promise<ActionResult<MemberListItem[]>> {
  const session = await getSession();
  if (!session) return unauthenticatedResult();
  try {
    const actor = await resolveActor(session, structureId);
    const members = await withTenantSession(actor, (ctx) => listMembers(ctx));
    return { ok: true, data: members };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticatedResult();
    if (err instanceof ForbiddenError) return { ok: false, message: dict.team.forbidden };
    throw err;
  }
}

export interface CreateMemberFormInput {
  name: string;
  email: string;
  password: string;
  role: MembershipRole;
  warehouseId: string | null;
}

export async function createMemberAction(
  structureId: string,
  input: CreateMemberFormInput
): Promise<ActionResult<{ userId: string }>> {
  const session = await getSession();
  if (!session) return unauthenticatedResult();
  try {
    const actor = await resolveActor(session, structureId);
    const created = await withTenantSession(actor, (ctx) =>
      createMember(ctx, {
        name: input.name,
        email: input.email,
        password: input.password,
        role: input.role,
        warehouseId: input.warehouseId,
      })
    );
    return { ok: true, data: { userId: created.userId } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticatedResult();
    if (err instanceof ForbiddenError) return { ok: false, message: dict.team.forbidden };
    if (err instanceof EmailAlreadyExistsError) return { ok: false, message: dict.team.errorEmailExists };
    if (err instanceof CannotCreateOwnerError) return { ok: false, message: dict.team.errorCannotCreateOwner };
    if (err instanceof OwnerCannotBeStoreScopedError) return { ok: false, message: dict.team.errorOwnerNoStore };
    if (err instanceof WarehouseNotFoundError) return { ok: false, message: err.message };
    if (err instanceof Error && err.name === "ZodError") return { ok: false, message: dict.team.errorGeneric };
    throw err;
  }
}

export async function changeMemberRoleAction(
  structureId: string,
  memberUserId: string,
  newRole: MembershipRole
): Promise<ActionResult<null>> {
  const session = await getSession();
  if (!session) return unauthenticatedResult();
  try {
    const actor = await resolveActor(session, structureId);
    await withTenantSession(actor, (ctx) => changeMemberRole(ctx, { memberUserId, newRole }));
    return { ok: true, data: null };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticatedResult();
    if (err instanceof ForbiddenError) return { ok: false, message: dict.team.forbidden };
    if (err instanceof CannotTargetOwnerRowError) return { ok: false, message: dict.team.errorCannotTargetOwner };
    if (err instanceof CannotPromoteToOwnerError) return { ok: false, message: dict.team.errorCannotPromoteToOwner };
    if (err instanceof CannotChangeOwnRoleError) return { ok: false, message: dict.team.errorCannotChangeOwnRole };
    if (err instanceof RoleChangeLastOwnerGuardError) return { ok: false, message: dict.team.errorLastOwner };
    if (err instanceof RoleChangeMemberNotFoundError) return { ok: false, message: err.message };
    throw err;
  }
}

export async function setMemberSuspendedAction(
  structureId: string,
  memberUserId: string,
  suspended: boolean
): Promise<ActionResult<null>> {
  const session = await getSession();
  if (!session) return unauthenticatedResult();
  try {
    const actor = await resolveActor(session, structureId);
    await withTenantSession(actor, (ctx) => setMemberSuspended(ctx, { memberUserId, suspended }));
    return { ok: true, data: null };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticatedResult();
    if (err instanceof ForbiddenError) return { ok: false, message: dict.team.forbidden };
    if (err instanceof CannotSuspendSelfError) return { ok: false, message: dict.team.errorCannotSuspendSelf };
    if (err instanceof SuspendLastOwnerGuardError) return { ok: false, message: dict.team.errorLastOwner };
    if (err instanceof SuspendMemberNotFoundError) return { ok: false, message: err.message };
    throw err;
  }
}

export async function assignMemberWarehouseAction(
  structureId: string,
  memberUserId: string,
  warehouseId: string | null
): Promise<ActionResult<null>> {
  const session = await getSession();
  if (!session) return unauthenticatedResult();
  try {
    const actor = await resolveActor(session, structureId);
    await withTenantSession(actor, (ctx) => assignMemberWarehouse(ctx, { memberUserId, warehouseId }));
    return { ok: true, data: null };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return unauthenticatedResult();
    if (err instanceof ForbiddenError) return { ok: false, message: dict.team.forbidden };
    if (err instanceof Error) return { ok: false, message: err.message };
    throw err;
  }
}
