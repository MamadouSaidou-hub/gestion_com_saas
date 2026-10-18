import { z } from "zod";
import { assertCan, can } from "@/modules/tenancy/permissions";
import { requireStepUp } from "@/modules/tenancy/step-up";
import { getStructureSettings } from "@/modules/tenancy/structure-settings";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { catalogService } from "@/modules/catalog";
import { inventoryService, Quantity } from "@/modules/inventory";
import { billingService } from "@/modules/billing";
import { computeLineAmounts, sumLineAmounts, type LineAmounts } from "../domain/pricing";
import { computeRequestFingerprint } from "../domain/fingerprint";
import {
  InvalidSaleInputError,
  ProductNotSellableError,
  AnonymousCreditSaleError,
  PaymentExceedsTotalError,
  IdempotencyKeyReuseError,
  DiscountLimitExceededError,
} from "../domain/errors";
import type { ConfirmSaleInput, ConfirmSaleResult, PaymentMethod } from "./dto";
import type { SalesRepository, InsertSaleLineInput, SalePaymentStatus } from "./ports";
import { toConfirmSaleResult } from "./mappers";

// ---------------------------------------------------------------------------
// confirmSale -- the heart of Phase 1. ONE atomic transaction (the caller's
// withTenantSession, via the `ctx` this function receives -- it opens NO
// transaction of its own). Step numbers in the comments below match the
// approved plan exactly; two deliberate, documented implementation notes
// are called out inline where this function's STATEMENT ORDER differs from
// the plan's literal numbering without changing any locking/atomicity
// guarantee.
//
// Idempotency argument (why step 2 can never observe a stray 'draft' row):
// a sale row only becomes visible to ANOTHER transaction once THIS
// transaction COMMITS -- which only happens after the full confirm path
// (steps 3-10) has run successfully. So `ON CONFLICT ... DO NOTHING`
// returning zero rows always means "a FULLY CONFIRMED sale already exists
// for this key", never "a draft is stuck mid-flight". A concurrent racer
// with the SAME key physically BLOCKS at the INSERT until the first
// resolves (commit or rollback), then sees the right outcome either way.
//
// H1 fix (security-reviewer, High): a replay used to return the existing
// sale on a bare idempotency-key conflict, with NO check that the NEW
// request's payload matches what originally claimed that key. A reused
// key with a DIFFERENT cart silently returned the OLD sale -- goods out,
// nothing recorded for what was actually rung up. `request_fingerprint`
// (migration 0012) is compared on every replay; a mismatch throws
// `IdempotencyKeyReuseError` instead of ever returning a different sale.
// ---------------------------------------------------------------------------

const PAYMENT_METHODS = ["cash", "mobile_money", "bank_transfer", "card", "other"] as const;

const confirmSaleSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  warehouseId: z.uuid(),
  customerId: z.uuid().nullable().optional(),
  currencyCode: z.string().length(3),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, "quantity must be a positive decimal string"),
        discountMinor: z.string().regex(/^\d+$/).optional(),
      })
    )
    .min(1),
  payment: z
    .object({
      method: z.enum(PAYMENT_METHODS),
      amountMinor: z.string().regex(/^\d+$/).optional(),
      full: z.boolean().optional(),
      reference: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  allowOversell: z.boolean().optional(),
});

export async function confirmSale(
  ctx: TenantSessionContext,
  rawInput: ConfirmSaleInput,
  repo: SalesRepository
): Promise<ConfirmSaleResult> {
  // Step 1: authorization, THEN shape validation.
  assertCan(ctx.actor, "sale:create");
  const input = confirmSaleSchema.parse(rawInput);

  for (const line of input.lines) {
    if (!Quantity.fromString(line.quantity).isPositive()) {
      throw new InvalidSaleInputError(
        `Line quantity for product "${line.productId}" must be strictly positive.`
      );
    }
  }
  const distinctProductIds = new Set(input.lines.map((l) => l.productId));
  if (distinctProductIds.size !== input.lines.length) {
    // Known limitation of inventory's applyStockOut (built in step 2): it
    // does not aggregate quantities for a repeated productId within one
    // call, which could under-count a combined shortage across two lines
    // of the SAME product. Rather than patch inventory in this step,
    // confirmSale rejects the ambiguous input outright -- merge quantities
    // into a single line client-side. Flagged for security-reviewer.
    throw new InvalidSaleInputError(
      "A sale cannot list the same product on more than one line -- merge quantities into a single line."
    );
  }

  if (input.payment) {
    if (!input.payment.full && input.payment.amountMinor === undefined) {
      throw new InvalidSaleInputError("A payment must set either `full: true` or `amountMinor`.");
    }
    if (!input.payment.full && moneyFromDto(input.payment.amountMinor as string) <= 0n) {
      throw new InvalidSaleInputError(
        "A payment, if present, must have a strictly positive amount -- omit `payment` entirely for a credit sale."
      );
    }
  }

  const hasAnyDiscount = input.lines.some(
    (l) => l.discountMinor !== undefined && moneyFromDto(l.discountMinor) > 0n
  );
  if (hasAnyDiscount) {
    assertCan(ctx.actor, "sale:discount");
  }

  // Step 2: claim the idempotency key FIRST, before any side-effecting
  // work (stock locking/decrementing, ticket allocation). The request
  // fingerprint is computed from the validated input (H1 fix) and stored
  // alongside the key -- it is what lets a replay be VERIFIED, not just
  // assumed, on the branch below.
  const requestFingerprint = computeRequestFingerprint({
    warehouseId: input.warehouseId,
    customerId: input.customerId ?? null,
    currencyCode: input.currencyCode,
    lines: input.lines,
    payment: input.payment ?? null,
  });

  const draft = await repo.tryInsertDraft(ctx, {
    customerId: input.customerId ?? null,
    warehouseId: input.warehouseId,
    currencyCode: input.currencyCode,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    createdBy: ctx.actor.userId,
  });

  if (!draft) {
    // Replay (see header comment for why the existing row is always fully
    // confirmed, never a stray draft). No second stock movement, no
    // second ticket number, no second audit entry -- we return here,
    // before touching catalog/inventory/billing/audit at all.
    const existing = await repo.findByIdempotencyKey(ctx, input.idempotencyKey);
    if (!existing) {
      // Lost the race to a transaction that then rolled back. Safe to
      // retry the whole operation from scratch with the same key.
      throw new InvalidSaleInputError(
        "Could not confirm or find the sale for this idempotency key -- retry."
      );
    }
    // H1 fix: verify, don't assume. A different cart under a reused key
    // must NEVER be silently resolved to the original sale.
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyReuseError();
    }
    const existingLines = await repo.listLines(ctx, existing.id);
    return toConfirmSaleResult(existing, existingLines, true);
  }

  // Step 3: re-read product prices/currency/active-status server-side.
  // NEVER trust client-sent prices (there IS no client price field).
  const products = await Promise.all(
    input.lines.map((line) => catalogService.getProduct(ctx, line.productId))
  );
  for (const product of products) {
    if (!product.isActive) {
      throw new ProductNotSellableError(product.id, "inactive");
    }
    if (product.currencyCode !== input.currencyCode) {
      throw new ProductNotSellableError(product.id, "currency_mismatch");
    }
  }
  const productById = new Map(products.map((p) => [p.id, p]));

  // Steps 4/5/7: lock stock_levels FOR UPDATE ordered by productId,
  // availability check, stock_movements insert (sale_id set),
  // stock_levels projection update -- all via inventory's OWN ctx-based
  // primitive (reuses the ordered-lock path already built in
  // stock-repository.ts; this transaction's ctx is passed through,
  // applyStockOut opens no transaction of its own).
  //
  // `allowOversell` is only ever HONORED if the actor also holds
  // `stock:oversell` -- resolved here with the non-throwing `can()`, not
  // `assertCan`. An unauthorized override request silently degrades to a
  // normal (non-overridden) availability check, which raises
  // InsufficientStockError exactly like a cashier who never asked for an
  // override -- per the approved product decision, a cashier must get
  // "insufficient stock", never a permission error that reveals the
  // override mechanism exists. applyStockOut's own internal assertCan
  // stays as defense-in-depth for a DIRECT caller; it is never reached
  // from this path because this function never passes
  // `allowOversell: true` unless already entitled.
  const effectiveAllowOversell = Boolean(input.allowOversell) && can(ctx.actor, "stock:oversell");

  const stockOutResult = await inventoryService.applyStockOut(ctx, {
    warehouseId: input.warehouseId,
    lines: input.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    reason: "sale",
    saleId: draft.id,
    allowOversell: effectiveAllowOversell,
  });

  // Step 6: compute line amounts and insert sale_lines (CUMP cost
  // snapshot from the stock-out result above -- without it, gross margin
  // is unknowable retroactively). Executed AFTER applyStockOut, not
  // before as the plan's literal numbering shows, SOLELY because the cost
  // snapshot sale_lines needs comes FROM applyStockOut's result. Both
  // statements are in the SAME transaction, so this does not change any
  // locking/atomicity guarantee -- only which INSERT statement runs
  // first. Flagged explicitly: the required LOCKING order (step 4 before
  // any line/total computation) is unchanged.
  const vatRate = await billingService.getVatRate(ctx);

  const computedLines = input.lines.map((line, index) => {
    const product = productById.get(line.productId);
    if (!product) {
      throw new InvalidSaleInputError(`Unknown product "${line.productId}".`);
    }
    const quantity = Quantity.fromString(line.quantity);
    const unitPriceMinor = moneyFromDto(product.defaultPriceMinor);
    const lineDiscountMinor = line.discountMinor ? moneyFromDto(line.discountMinor) : 0n;
    const amounts: LineAmounts = computeLineAmounts(quantity, unitPriceMinor, lineDiscountMinor, vatRate);
    const unitCostMinor = BigInt(stockOutResult.unitCostMinorByProductId[line.productId] ?? "0");
    return {
      productId: line.productId,
      quantity: line.quantity,
      unitPriceMinor,
      unitCostMinor,
      amounts,
      lineNo: index + 1,
    };
  });

  const lineInserts: InsertSaleLineInput[] = computedLines.map((c) => ({
    productId: c.productId,
    quantity: c.quantity,
    unitPriceMinor: c.unitPriceMinor,
    currencyCode: input.currencyCode,
    lineTotalMinor: c.amounts.lineTotalMinor,
    vatRate,
    discountMinor: c.amounts.discountMinor,
    unitCostMinor: c.unitCostMinor,
    lineNo: c.lineNo,
  }));

  const insertedLines = await repo.insertLines(ctx, draft.id, lineInserts);
  const totals = sumLineAmounts(computedLines.map((c) => c.amounts));

  // H4 fix (security-reviewer, High): `structure_settings` was read by NO
  // code. A discount enforces `max_discount_pct` (hard cap, independent
  // of SoD) and, separately, requires step-up when it's at or above
  // `sod_threshold_minor` (NULL = disabled, the approved default -- a
  // one-person shop never hits this). `requireStepUp` throws today (no
  // OTP provider yet, D5) -- that is the correct fail-closed behaviour
  // until one exists, not a bug.
  if (totals.discountMinor > 0n) {
    const settings = await getStructureSettings(ctx);
    if (settings.maxDiscountPct !== null && totals.subtotalMinor > 0n) {
      const maxPctScaled = BigInt(Math.round(Number(settings.maxDiscountPct) * 100)); // percent * 100
      const discountPctScaled = (totals.discountMinor * 10_000n) / totals.subtotalMinor; // percent * 100
      if (discountPctScaled > maxPctScaled) {
        throw new DiscountLimitExceededError(settings.maxDiscountPct);
      }
    }
    if (settings.sodThresholdMinor !== null && totals.discountMinor >= settings.sodThresholdMinor) {
      await requireStepUp(ctx.actor, "sale:discount");
    }
  }

  // Step 8: allocate the TICKET number (not an invoice -- tickets by
  // default, invoice on demand later) via document_counters, as LATE as
  // possible: this is the one lock that serializes the whole tenant's
  // sales.
  //
  // H5 fix (security-reviewer): fiscal year and `confirmedAt` now derive
  // from the SAME `Date` value, captured once, instead of two separate
  // `new Date()` calls that could (in the pathological case of confirming
  // exactly at a year boundary) disagree with each other.
  const confirmedAt = new Date();
  const fiscalYear = confirmedAt.getUTCFullYear();
  const ticketNumber = await billingService.allocateTicketNumber(ctx, fiscalYear);

  // Step 9: payment (optional). Credit sales are supported -- zero
  // payment is valid. ANY unpaid balance -- zero payment (credit) OR a
  // partial payment -- opens a receivable and therefore requires an
  // identified customer (no receivable against an anonymous walk-in):
  // this was corrected from an earlier, narrower version of this rule
  // that only guarded the partial case -- that asymmetry was a gap in
  // the spec, not a deliberate rule (see AnonymousCreditSaleError and
  // db/README.md entry 2s). Only a FULLY paid sale -- no balance left at
  // all -- may be anonymous.
  //
  // H2 fix (security-reviewer, High): `payment.full` tells the SERVER to
  // use `totals.totalMinor` (TTC, computed server-side above) instead of
  // trusting a client-sent amount -- the POS only ever knows the HT
  // subtotal before VAT is applied here, so a client-computed "total"
  // silently falls short the moment vat_rate > 0, which used to push
  // every "pay in full" cash sale into the credit branch and refuse it
  // for lack of a customer (AnonymousCreditSaleError) on ANY VAT-
  // registered shop.
  const paidMinor = input.payment
    ? input.payment.full
      ? totals.totalMinor
      : moneyFromDto(input.payment.amountMinor as string)
    : 0n;
  if (paidMinor > totals.totalMinor) {
    throw new PaymentExceedsTotalError();
  }

  let paymentStatus: SalePaymentStatus;
  if (totals.totalMinor === 0n) {
    if (paidMinor !== 0n) {
      throw new InvalidSaleInputError("Cannot record a payment against a zero-total sale.");
    }
    paymentStatus = "paid"; // nothing owed -- no balance, anonymous is fine
  } else if (paidMinor === totals.totalMinor) {
    paymentStatus = "paid"; // fully paid -- no balance left, anonymous is fine
  } else {
    // paidMinor < totalMinor (zero OR partial) -- a balance remains.
    if (!input.customerId) {
      throw new AnonymousCreditSaleError();
    }
    paymentStatus = paidMinor === 0n ? "unpaid" : "partial";
  }

  if (paidMinor > 0n && input.payment) {
    await billingService.recordSalePayment(ctx, {
      saleId: draft.id,
      customerId: input.customerId ?? null,
      amountMinor: paidMinor,
      currencyCode: input.currencyCode,
      method: input.payment.method satisfies PaymentMethod,
      // Deterministically derived -- a retry with the SAME confirmSale
      // idempotencyKey reaches this exact point at most once per
      // successful commit (see header comment), but the derived key still
      // gives the payment row its own, independently-meaningful identity
      // (payments.idempotency_key has its own unique index).
      idempotencyKey: `${input.idempotencyKey}:payment`,
      reference: input.payment.reference ?? null,
      // H5 fix: shares the SAME app-clock value as confirmedAt/fiscalYear
      // above, rather than letting the payment row fall back to the
      // database's own DEFAULT now() (a second, potentially drifted
      // clock) -- see billingService.recordSalePayment / payment-
      // repository.ts.
      receivedAt: confirmedAt,
    });
  }

  const header = await repo.confirmHeader(ctx, draft.id, {
    ticketNumber,
    fiscalYear,
    subtotalMinor: totals.subtotalMinor,
    vatMinor: totals.vatMinor,
    discountMinor: totals.discountMinor,
    totalMinor: totals.totalMinor,
    paidMinor,
    paymentStatus,
    confirmedAt,
  });

  // Step 10: audit, in the SAME transaction. Ids + amounts only -- no
  // customer name, no phone (the PII guard throws on those keys, by
  // design). Never written on the replay path above.
  await ctx.audit.append({
    action: "sale.confirmed",
    targetType: "sale",
    targetId: draft.id,
    payload: {
      idempotencyKey: input.idempotencyKey,
      lineCount: insertedLines.length,
      subtotalMinor: moneyToDto(totals.subtotalMinor),
      vatMinor: moneyToDto(totals.vatMinor),
      discountMinor: moneyToDto(totals.discountMinor),
      totalMinor: moneyToDto(totals.totalMinor),
      paidMinor: moneyToDto(paidMinor),
      oversellOverride: effectiveAllowOversell,
      ticketNumber: ticketNumber.toString(),
    },
  });

  // Step 11: COMMIT happens implicitly when withTenantSession's callback
  // resolves (see docs/platform.md). If ANYTHING above threw -- including
  // this audit.append call -- drizzle's db.transaction rolls back
  // everything: no sale, no movement, no ticket number consumed.
  return toConfirmSaleResult(header, insertedLines, false);
}
