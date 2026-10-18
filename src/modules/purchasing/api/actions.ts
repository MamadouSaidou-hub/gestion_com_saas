"use server";

import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { resolveStoreScope } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { ForbiddenError, UnauthenticatedError, NotAMemberError } from "@/platform/errors";
import { SupplierNotFoundError } from "@/modules/catalog";
import { rebatesService } from "@/modules/rebates";
import {
  purchasingService,
  type RecordDeliveryInput,
  type RecordSupplierPaymentInput,
  type DeliveryDto,
  type SupplierPaymentDto,
  type SupplierDebtDto,
  InvalidDeliveryInputError,
  DeliveryNotFoundError,
  DeliveryIdempotencyKeyReuseError,
  InvalidSupplierPaymentInputError,
  SupplierPaymentNotFoundError,
  SupplierPaymentAlreadyVoidedError,
  StoreScopedActorCannotTouchSupplierDebtError,
} from "../index";

// ---------------------------------------------------------------------------
// Thin "use server" Server Actions -- same five-step chain as every other
// module (getSession -> resolveActor -> withTenantSession -> use case), no
// business logic/assertCan here.
// ---------------------------------------------------------------------------

type ActionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ALREADY_VOIDED"
  | "IDEMPOTENCY_KEY_REUSE"
  | "INVALID_INPUT"
  | "STORE_SCOPED_NO_DEBT_ACCESS"
  | "UNKNOWN";

type ActionResult<T> = { ok: true; data: T } | { ok: false; code: ActionErrorCode; message: string };

function mapError(err: unknown): { code: ActionErrorCode; message: string } {
  if (err instanceof UnauthenticatedError) {
    return { code: "UNAUTHENTICATED", message: "Session expirée." };
  }
  if (err instanceof ForbiddenError) {
    return { code: "FORBIDDEN", message: err.message };
  }
  if (err instanceof NotAMemberError) {
    return { code: "FORBIDDEN", message: "Vous n'êtes pas membre de cette structure." };
  }
  if (err instanceof DeliveryNotFoundError || err instanceof SupplierPaymentNotFoundError || err instanceof SupplierNotFoundError) {
    return { code: "NOT_FOUND", message: err.message };
  }
  if (err instanceof SupplierPaymentAlreadyVoidedError) {
    return { code: "ALREADY_VOIDED", message: err.message };
  }
  if (err instanceof DeliveryIdempotencyKeyReuseError) {
    return { code: "IDEMPOTENCY_KEY_REUSE", message: err.message };
  }
  if (err instanceof StoreScopedActorCannotTouchSupplierDebtError) {
    return { code: "STORE_SCOPED_NO_DEBT_ACCESS", message: err.message };
  }
  if (err instanceof InvalidDeliveryInputError || err instanceof InvalidSupplierPaymentInputError) {
    return { code: "INVALID_INPUT", message: err.message };
  }
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : "Erreur inconnue." };
}

export async function recordDeliveryAction(
  structureId: string,
  input: RecordDeliveryInput
): Promise<ActionResult<DeliveryDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, async (ctx) => {
      const delivery = await purchasingService.recordDelivery(ctx, input);
      // Rebates' supplier-side cyclic auto-trigger -- composed here, SAME
      // ctx/transaction, to avoid a purchasing<->rebates module cycle while
      // still committing/rolling back atomically together. See
      // record-delivery.ts's header comment for the full rationale. A
      // replay (delivery.replay === true) must NOT re-trigger -- the grant
      // already happened (or didn't) on the original commit.
      if (!delivery.replay) {
        await rebatesService.checkAndGrantSupplierTier(ctx, { supplierId: delivery.supplierId });
      }
      return delivery;
    });
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function recordSupplierPaymentAction(
  structureId: string,
  input: RecordSupplierPaymentInput
): Promise<ActionResult<SupplierPaymentDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => purchasingService.recordSupplierPayment(ctx, input));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function voidSupplierPaymentAction(
  structureId: string,
  paymentId: string
): Promise<ActionResult<SupplierPaymentDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => purchasingService.voidSupplierPayment(ctx, paymentId));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function listDeliveriesAction(
  structureId: string,
  supplierId?: string,
  requestedWarehouseId?: string | null
): Promise<ActionResult<DeliveryDto[]>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const storeScope = resolveStoreScope(actor, requestedWarehouseId);
    const data = await withTenantSession(actor, (ctx) =>
      purchasingService.listDeliveries(ctx, { supplierId, storeScope })
    );
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function getSupplierDebtAction(
  structureId: string,
  supplierId: string
): Promise<ActionResult<SupplierDebtDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => purchasingService.getSupplierDebt(ctx, supplierId));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}
