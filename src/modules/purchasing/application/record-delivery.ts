import { z } from "zod";
import { assertCan, assertStoreAccess } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { catalogService } from "@/modules/catalog";
import { inventoryService, Quantity } from "@/modules/inventory";
import { billingService } from "@/modules/billing";
import { computeDeliveryFingerprint } from "../domain/fingerprint";
import { InvalidDeliveryInputError, DeliveryIdempotencyKeyReuseError } from "../domain/errors";
import type { RecordDeliveryInput, DeliveryDto } from "./dto";
import type { DeliveryRepository, InsertDeliveryLineInput } from "./ports";
import { toDeliveryDto } from "./mappers";

const recordDeliverySchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  currencyCode: z.string().length(3),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, "quantity must be a positive decimal string"),
        unitCostMinor: z.string().regex(/^\d+$/),
      })
    )
    .min(1),
  dueAt: z.string().datetime().nullable().optional(),
});

// ---------------------------------------------------------------------------
// recordDelivery -- ONE atomic transaction (the caller's withTenantSession,
// via `ctx`; opens NO transaction of its own, same convention as
// confirmSale/createTransfer). Inserts the delivery header + lines, posts
// the "in" stock_movements carrying `supplier_delivery_id` (what actually
// feeds CUMP via inventoryService.applyDeliveryIn), allocates a gapless
// `reference` from document_counters (doc_type='delivery'), and opens a
// debt whenever totalMinor > 0 (paymentStatus starts 'unpaid' -- paidMinor
// only ever moves via recordSupplierPayment's atomic increment, see that
// file). Idempotency by key + request fingerprint, exactly like
// confirmSale/createTransfer: a row is only visible to ANOTHER call once
// this transaction commits, so `ON CONFLICT ... DO NOTHING` returning zero
// rows always means "a fully-recorded delivery already exists for this
// key", never a half-finished one.
//
// Judgment call: the supplier-side rebate cyclic auto-trigger
// (rebatesService.checkAndGrantSupplierTier) is deliberately NOT called
// from inside this function -- calling it here would make `purchasing`
// depend on `rebates`, which itself depends on `purchasing` (it reads
// `sumDeliveredQuantitySince` through this module's own public surface) --
// a module cycle. The caller (purchasing's own Server Action, api/actions.ts)
// calls both `purchasingService.recordDelivery` and
// `rebatesService.checkAndGrantSupplierTier` with the SAME `ctx`, inside the
// SAME `withTenantSession` transaction -- satisfying "auto-triggers inside
// recordDelivery's transaction" at the transaction-boundary level (which is
// the property that actually matters: all-or-nothing commit) without a
// circular module import. Flag for security-reviewer if a stricter reading
// (literally inside this function) is required.
// ---------------------------------------------------------------------------
export async function recordDelivery(
  ctx: TenantSessionContext,
  rawInput: RecordDeliveryInput,
  repo: DeliveryRepository
): Promise<DeliveryDto> {
  assertCan(ctx.actor, "delivery:record");
  const input = recordDeliverySchema.parse(rawInput);

  // multi-store: a `warehouseId` arriving from the client MUST pass through
  // assertStoreAccess before anything else -- a gerant recording a delivery
  // against a DIFFERENT store is rejected here, before any stock movement,
  // reference allocation or audit entry.
  assertStoreAccess(ctx.actor, input.warehouseId);

  const distinctProductIds = new Set(input.lines.map((l) => l.productId));
  if (distinctProductIds.size !== input.lines.length) {
    throw new InvalidDeliveryInputError(
      "A delivery cannot list the same product on more than one line -- merge quantities into a single line."
    );
  }
  for (const line of input.lines) {
    if (!Quantity.fromString(line.quantity).isPositive()) {
      throw new InvalidDeliveryInputError(
        `Line quantity for product "${line.productId}" must be strictly positive.`
      );
    }
  }

  const requestFingerprint = computeDeliveryFingerprint({
    supplierId: input.supplierId,
    warehouseId: input.warehouseId,
    currencyCode: input.currencyCode,
    lines: input.lines,
  });

  const draft = await repo.tryInsertDraft(ctx, {
    supplierId: input.supplierId,
    warehouseId: input.warehouseId,
    currencyCode: input.currencyCode,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    createdBy: ctx.actor.userId,
  });

  if (!draft) {
    // Replay -- see header comment for why the existing row is always
    // fully recorded, never a stray half-built one.
    const existing = await repo.findByIdempotencyKey(ctx, input.idempotencyKey);
    if (!existing) {
      throw new InvalidDeliveryInputError(
        "Could not record or find the delivery for this idempotency key -- retry."
      );
    }
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new DeliveryIdempotencyKeyReuseError();
    }
    const existingLines = await repo.listLines(ctx, existing.id);
    return toDeliveryDto(existing, existingLines, true);
  }

  // Re-verify the supplier exists IN THIS TENANT -- never trust a
  // client-sent id blindly; this also surfaces SupplierNotFoundError
  // instead of a raw FK violation if it's wrong.
  await catalogService.getSupplier(ctx, input.supplierId);

  // Lines carry their OWN unit cost (what was actually paid this delivery --
  // never re-derived from the product's defaultCostMinor, unlike a sale's
  // price which IS re-read server-side; a delivery's cost is inherently
  // per-delivery data the supplier invoice states).
  const lineInserts: InsertDeliveryLineInput[] = input.lines.map((line, index) => {
    const quantity = Quantity.fromString(line.quantity);
    const unitCostMinor = moneyFromDto(line.unitCostMinor);
    const lineTotalMinor = quantity.multiplyToMinor(unitCostMinor);
    return { productId: line.productId, quantity, unitCostMinor, lineTotalMinor, lineNo: index + 1 };
  });
  const totalMinor = lineInserts.reduce((acc, l) => acc + l.lineTotalMinor, 0n);

  // Feeds CUMP (D9) -- the "in" leg, SAME transaction, carrying
  // supplier_delivery_id (the exclusive-arc composite-FK column the 0014/
  // 0015 migrations built specifically for this).
  await inventoryService.applyDeliveryIn(ctx, {
    warehouseId: input.warehouseId,
    supplierDeliveryId: draft.id,
    currencyCode: input.currencyCode,
    lines: lineInserts.map((l) => ({
      productId: l.productId,
      quantity: l.quantity.toDbString(),
      unitCostMinor: l.unitCostMinor,
    })),
  });

  const insertedLines = await repo.insertLines(ctx, draft.id, lineInserts);

  const receivedAt = new Date();
  const fiscalYear = receivedAt.getUTCFullYear();
  const referenceNumber = await billingService.allocateDeliveryReference(ctx, fiscalYear);
  const reference = `LIV-${fiscalYear}-${referenceNumber.toString().padStart(6, "0")}`;

  // Debt: paymentStatus starts 'unpaid' the moment totalMinor > 0 --
  // paidMinor stays 0 until recordSupplierPayment's atomic increment moves
  // it. A zero-total delivery (free sample, correction line) is 'paid'
  // outright -- nothing is ever owed for it.
  const paymentStatus = totalMinor === 0n ? "paid" : "unpaid";

  const header = await repo.finalizeHeader(ctx, draft.id, {
    reference,
    fiscalYear,
    totalMinor,
    paymentStatus,
    receivedAt,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
  });

  // ids + amounts only -- no supplier name/phone (PII guard throws on those
  // key names by design).
  await ctx.audit.append({
    action: "delivery.recorded",
    targetType: "supplier_delivery",
    targetId: draft.id,
    payload: {
      idempotencyKey: input.idempotencyKey,
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      lineCount: insertedLines.length,
      totalMinor: moneyToDto(totalMinor),
      reference,
    },
  });

  return toDeliveryDto(header, insertedLines, false);
}
