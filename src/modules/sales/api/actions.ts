"use server";

import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { catalogService } from "@/modules/catalog";
import { ForbiddenError } from "@/platform/errors";
import { StepUpNotImplementedError } from "@/modules/tenancy/step-up";
import { InsufficientStockError } from "@/modules/inventory";
import { salesService, type ConfirmSaleInput, type ConfirmSaleResult } from "../index";
import {
  InvalidSaleInputError,
  ProductNotSellableError,
  AnonymousCreditSaleError,
  PaymentExceedsTotalError,
  IdempotencyKeyReuseError,
  DiscountLimitExceededError,
} from "../domain";

// ---------------------------------------------------------------------------
// confirmSaleAction -- the ONE Server Action the POS calls. Returns a
// structured result instead of throwing, so the client's retry-queue logic
// can reliably tell a RETRYABLE failure (network/unexpected -- the queued
// intent stays pending and will be retried with the SAME idempotency key)
// apart from a DEFINITIVE business rejection (insufficient stock, not
// allowed, bad input -- the queued intent must stop retrying and surface
// to the cashier instead of hammering the server forever).
//
// `customerName` (free text, optional) is resolved/created into a real
// `customerId` INSIDE the same ctx confirmSale will use -- there is no
// dedicated customers module yet (out of this phase's scope), and asking
// the POS for a customer ID rather than a name would not be usable by a
// cashier. Case-insensitive match on name within the tenant; creates a new
// customer row if none matches. This happens in the SAME transaction as
// confirmSale, so a rolled-back sale does not leave a stray new customer
// behind on a failed attempt that then succeeds under a different name.
// ---------------------------------------------------------------------------

export type ConfirmSaleErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INSUFFICIENT_STOCK"
  | "ANONYMOUS_CREDIT"
  | "PRODUCT_NOT_SELLABLE"
  | "INVALID_INPUT"
  | "PAYMENT_EXCEEDS_TOTAL"
  | "IDEMPOTENCY_KEY_REUSE"
  | "DISCOUNT_LIMIT_EXCEEDED"
  | "STEP_UP_REQUIRED"
  | "UNKNOWN";

export type ConfirmSaleActionResult =
  | { ok: true; sale: ConfirmSaleResult }
  | { ok: false; code: ConfirmSaleErrorCode; message: string; retryable: boolean };

export interface ConfirmSaleActionInput extends Omit<ConfirmSaleInput, "customerId"> {
  customerName?: string | null;
}

export async function confirmSaleAction(
  structureId: string,
  input: ConfirmSaleActionInput
): Promise<ConfirmSaleActionResult> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée.", retryable: false };
    }
    const actor = await resolveActor(session, structureId);

    const sale = await withTenantSession(actor, async (ctx) => {
      const trimmedName = input.customerName?.trim();
      const customerId = trimmedName
        ? await catalogService.findOrCreateCustomerByName(ctx, trimmedName)
        : null;

      const { customerName: _omit, ...rest } = input;
      void _omit;
      return salesService.confirmSale(ctx, { ...rest, customerId });
    });

    return { ok: true, sale };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: "FORBIDDEN", message: err.message, retryable: false };
    }
    if (err instanceof InsufficientStockError) {
      return { ok: false, code: "INSUFFICIENT_STOCK", message: err.message, retryable: false };
    }
    if (err instanceof AnonymousCreditSaleError) {
      return { ok: false, code: "ANONYMOUS_CREDIT", message: err.message, retryable: false };
    }
    if (err instanceof ProductNotSellableError) {
      return { ok: false, code: "PRODUCT_NOT_SELLABLE", message: err.message, retryable: false };
    }
    if (err instanceof PaymentExceedsTotalError) {
      return { ok: false, code: "PAYMENT_EXCEEDS_TOTAL", message: err.message, retryable: false };
    }
    if (err instanceof InvalidSaleInputError) {
      return { ok: false, code: "INVALID_INPUT", message: err.message, retryable: false };
    }
    if (err instanceof IdempotencyKeyReuseError) {
      // H1 fix: never retryable -- resending the SAME mismatched key will
      // never succeed, the client must generate a NEW key for this cart.
      return { ok: false, code: "IDEMPOTENCY_KEY_REUSE", message: err.message, retryable: false };
    }
    if (err instanceof DiscountLimitExceededError) {
      return { ok: false, code: "DISCOUNT_LIMIT_EXCEEDED", message: err.message, retryable: false };
    }
    if (err instanceof StepUpNotImplementedError) {
      // L-a fix (security-reviewer follow-up): this used to fall through
      // to the generic UNKNOWN/retryable:true bucket, which made the
      // offline queue replay a discount-above-threshold sale FOREVER
      // (requireStepUp throws unconditionally today, by design, until an
      // OTP provider exists -- see step-up.ts). Never retryable: resending
      // the identical request hits the exact same fail-closed wall every
      // time.
      return {
        ok: false,
        code: "STEP_UP_REQUIRED",
        message: "Validation renforcée requise pour cette action -- non disponible pour le moment.",
        retryable: false,
      };
    }
    // Anything else (network blip surfacing as a DB error, transient
    // infra failure, ...) is treated as retryable -- the SAME idempotency
    // key is safe to resend, confirmSale's own ON CONFLICT arbiter
    // guarantees no duplicate regardless of how many times this happens.
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Erreur inconnue.",
      retryable: true,
    };
  }
}
