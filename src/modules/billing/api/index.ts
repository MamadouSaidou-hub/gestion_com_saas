"use server";

import { z } from "zod";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { ForbiddenError, UnauthenticatedError } from "@/platform/errors";
import {
  billingService,
  SaleNotFoundError,
  SaleNotConfirmedError,
  InvalidPaymentInputError,
  type InvoiceDto,
  type PaymentDto,
} from "../index";

// ---------------------------------------------------------------------------
// Thin Server Actions for the billing module -- same five-step chain and
// structured-result convention as sales/api/actions.ts
// (confirmSaleAction)/catalog/api/actions.ts: never throw a raw Error class
// across the Server Action boundary (Next.js strips it to a generic digest
// in production), always return `{ ok, ... }`.
// ---------------------------------------------------------------------------

export type BillingActionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NOT_CONFIRMED"
  | "INVALID_INPUT"
  | "UNKNOWN";

export type IssueInvoiceActionResult =
  | { ok: true; invoice: InvoiceDto }
  | { ok: false; code: BillingActionErrorCode; message: string };

export async function issueInvoiceForSaleAction(
  structureId: string,
  saleId: string
): Promise<IssueInvoiceActionResult> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const invoice = await withTenantSession(actor, (ctx) => billingService.issueInvoiceForSale(ctx, saleId));
    return { ok: true, invoice };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: "FORBIDDEN", message: "Vous n'avez pas le droit d'émettre une facture." };
    }
    if (err instanceof SaleNotFoundError) {
      return { ok: false, code: "NOT_FOUND", message: "Vente introuvable." };
    }
    if (err instanceof SaleNotConfirmedError) {
      return { ok: false, code: "NOT_CONFIRMED", message: "Cette vente n'est pas confirmée." };
    }
    if (err instanceof InvalidPaymentInputError) {
      return { ok: false, code: "INVALID_INPUT", message: err.message };
    }
    return { ok: false, code: "UNKNOWN", message: "Impossible d'émettre la facture." };
  }
}

const recordPaymentSchema = z.object({
  saleId: z.uuid(),
  amountMinor: z.string().regex(/^\d+$/),
  method: z.enum(["cash", "mobile_money", "bank_transfer", "card", "other"]),
  reference: z.string().trim().max(200).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export type RecordPaymentActionResult =
  | { ok: true; payment: PaymentDto }
  | { ok: false; code: BillingActionErrorCode; message: string };

// recordPaymentAction -- the "Encaisser" action on the client detail
// screen. Calls `billingService.recordPayment` UNCHANGED: same idempotency
// key, same atomic increment, same audit entry as every other caller of
// this use case. This file adds NO second payment path.
export async function recordPaymentAction(
  structureId: string,
  input: {
    saleId: string;
    amountMinor: string;
    method: "cash" | "mobile_money" | "bank_transfer" | "card" | "other";
    reference?: string | null;
    idempotencyKey: string;
  }
): Promise<RecordPaymentActionResult> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const parsed = recordPaymentSchema.parse(input);
    const payment = await withTenantSession(actor, (ctx) => billingService.recordPayment(ctx, parsed));
    return { ok: true, payment };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: "FORBIDDEN", message: "Vous n'avez pas le droit d'encaisser ce paiement." };
    }
    if (err instanceof SaleNotFoundError) {
      return { ok: false, code: "NOT_FOUND", message: "Vente introuvable." };
    }
    if (err instanceof SaleNotConfirmedError) {
      return { ok: false, code: "NOT_CONFIRMED", message: "Cette vente n'est pas confirmée." };
    }
    if (err instanceof InvalidPaymentInputError) {
      return { ok: false, code: "INVALID_INPUT", message: err.message };
    }
    return { ok: false, code: "UNKNOWN", message: "Impossible d'enregistrer ce paiement." };
  }
}
