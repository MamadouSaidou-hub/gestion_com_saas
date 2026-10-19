"use server";

import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { ForbiddenError, UnauthenticatedError, NotAMemberError } from "@/platform/errors";
import {
  rebatesService,
  type CreateRebateScaleInput,
  type RebateScaleDto,
  type RebateGrantDto,
  type RebateProgressDto,
  type RebateTierInput,
  RebateScaleNotFoundError,
} from "../index";

type ActionErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT" | "UNKNOWN";
type ActionResult<T> = { ok: true; data: T } | { ok: false; code: ActionErrorCode; message: string };

function mapError(err: unknown): { code: ActionErrorCode; message: string } {
  if (err instanceof UnauthenticatedError) return { code: "UNAUTHENTICATED", message: "Session expirée." };
  if (err instanceof ForbiddenError) return { code: "FORBIDDEN", message: err.message };
  if (err instanceof NotAMemberError) {
    return { code: "FORBIDDEN", message: "Vous n'êtes pas membre de cette structure." };
  }
  if (err instanceof RebateScaleNotFoundError) return { code: "NOT_FOUND", message: err.message };
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : "Erreur inconnue." };
}

export async function createRebateScaleAction(
  structureId: string,
  input: CreateRebateScaleInput
): Promise<ActionResult<RebateScaleDto>> {
  try {
    const session = await getSession();
    if (!session) return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => rebatesService.createRebateScale(ctx, input));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function updateRebateScaleTiersAction(
  structureId: string,
  scaleId: string,
  tiers: RebateTierInput[]
): Promise<ActionResult<RebateScaleDto>> {
  try {
    const session = await getSession();
    if (!session) return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) =>
      rebatesService.updateRebateScaleTiers(ctx, scaleId, tiers)
    );
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function calculateCustomerRebateAction(
  structureId: string,
  customerId: string
): Promise<ActionResult<RebateGrantDto | null>> {
  try {
    const session = await getSession();
    if (!session) return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => rebatesService.calculateCustomerRebate(ctx, customerId));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function verifyRebateTierAction(
  structureId: string,
  supplierId: string
): Promise<ActionResult<RebateGrantDto | null>> {
  try {
    const session = await getSession();
    if (!session) return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) =>
      rebatesService.verifyRebateTier(ctx, { supplierId })
    );
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function getCustomerRebateProgressAction(
  structureId: string,
  customerId: string
): Promise<ActionResult<RebateProgressDto | null>> {
  try {
    const session = await getSession();
    if (!session) return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) =>
      rebatesService.getCustomerRebateProgress(ctx, customerId)
    );
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function getSupplierRebateProgressAction(
  structureId: string,
  supplierId: string
): Promise<ActionResult<RebateProgressDto | null>> {
  try {
    const session = await getSession();
    if (!session) return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) =>
      rebatesService.getSupplierRebateProgress(ctx, supplierId)
    );
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}
