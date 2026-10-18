"use server";

import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { resolveStoreScope } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { ForbiddenError, UnauthenticatedError, NotAMemberError } from "@/platform/errors";
import { InsufficientStockError } from "@/modules/inventory";
import {
  stockTransfersService,
  type CreateTransferInput,
  type CancelTransferInput,
  type OpenStockCountInput,
  type ValidateStockCountInput,
  type TransferDto,
  type StockCountDto,
  InvalidTransferInputError,
  TransferNotFoundError,
  TransferNotInTransitError,
  TransferIdempotencyKeyReuseError,
  InvalidStockCountInputError,
  StockCountNotFoundError,
  StockCountNotDraftError,
} from "../index";

// ---------------------------------------------------------------------------
// Thin "use server" Server Actions -- getSession -> resolveActor ->
// withTenantSession -> use case. Same five-step chain as every other
// module's api/actions.ts; no business logic here, `assertCan` happens
// inside each use case, never here.
//
// Every action returns a structured `{ ok, ... }` result instead of
// throwing across the RSC/Server-Action boundary, so the UI can tell a
// definitive business rejection (insufficient stock, not your store, not
// in transit anymore) apart from an unexpected error -- same convention as
// sales' confirmSaleAction.
// ---------------------------------------------------------------------------

type ActionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NOT_IN_TRANSIT"
  | "NOT_DRAFT"
  | "INSUFFICIENT_STOCK"
  | "IDEMPOTENCY_KEY_REUSE"
  | "INVALID_INPUT"
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
  if (err instanceof TransferNotFoundError || err instanceof StockCountNotFoundError) {
    return { code: "NOT_FOUND", message: err.message };
  }
  if (err instanceof TransferNotInTransitError) {
    return { code: "NOT_IN_TRANSIT", message: err.message };
  }
  if (err instanceof StockCountNotDraftError) {
    return { code: "NOT_DRAFT", message: err.message };
  }
  if (err instanceof InsufficientStockError) {
    return { code: "INSUFFICIENT_STOCK", message: err.message };
  }
  if (err instanceof TransferIdempotencyKeyReuseError) {
    return { code: "IDEMPOTENCY_KEY_REUSE", message: err.message };
  }
  if (err instanceof InvalidTransferInputError || err instanceof InvalidStockCountInputError) {
    return { code: "INVALID_INPUT", message: err.message };
  }
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : "Erreur inconnue." };
}

export async function createTransferAction(
  structureId: string,
  input: CreateTransferInput
): Promise<ActionResult<TransferDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => stockTransfersService.createTransfer(ctx, input));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function receiveTransferAction(
  structureId: string,
  transferId: string
): Promise<ActionResult<TransferDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => stockTransfersService.receiveTransfer(ctx, transferId));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function cancelTransferAction(
  structureId: string,
  input: CancelTransferInput
): Promise<ActionResult<TransferDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => stockTransfersService.cancelTransfer(ctx, input));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function listTransfersAction(
  structureId: string,
  requestedWarehouseId?: string | null
): Promise<ActionResult<TransferDto[]>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const storeScope = resolveStoreScope(actor, requestedWarehouseId);
    const data = await withTenantSession(actor, (ctx) =>
      stockTransfersService.listTransfers(ctx, { storeScope })
    );
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function openStockCountAction(
  structureId: string,
  input: OpenStockCountInput
): Promise<ActionResult<StockCountDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => stockTransfersService.openStockCount(ctx, input));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function validateStockCountAction(
  structureId: string,
  input: ValidateStockCountInput
): Promise<ActionResult<StockCountDto>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const data = await withTenantSession(actor, (ctx) => stockTransfersService.validateStockCount(ctx, input));
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function listStockCountsAction(
  structureId: string,
  requestedWarehouseId?: string | null
): Promise<ActionResult<StockCountDto[]>> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const storeScope = resolveStoreScope(actor, requestedWarehouseId);
    const data = await withTenantSession(actor, (ctx) =>
      stockTransfersService.listStockCounts(ctx, { storeScope })
    );
    return { ok: true, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false, code, message };
  }
}

export async function listVarianceLinesAction(
  structureId: string,
  requestedWarehouseId?: string | null
) {
  const session = await getSession();
  if (!session) {
    return { ok: false as const, code: "UNAUTHENTICATED" as const, message: "Session expirée." };
  }
  try {
    const actor = await resolveActor(session, structureId);
    const storeScope = resolveStoreScope(actor, requestedWarehouseId);
    const data = await withTenantSession(actor, (ctx) =>
      stockTransfersService.listVarianceLines(ctx, { storeScope })
    );
    return { ok: true as const, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false as const, code, message };
  }
}

export async function getInTransitAction(structureId: string, requestedWarehouseId?: string | null) {
  const session = await getSession();
  if (!session) {
    return { ok: false as const, code: "UNAUTHENTICATED" as const, message: "Session expirée." };
  }
  try {
    const actor = await resolveActor(session, structureId);
    const storeScope = resolveStoreScope(actor, requestedWarehouseId);
    const data = await withTenantSession(actor, (ctx) =>
      stockTransfersService.getInTransitByProduct(ctx, storeScope)
    );
    return { ok: true as const, data };
  } catch (err) {
    const { code, message } = mapError(err);
    return { ok: false as const, code, message };
  }
}
