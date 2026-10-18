import { z } from "zod";
import { assertCan, assertStoreAccess } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { catalogService } from "@/modules/catalog";
import { inventoryService, Quantity } from "@/modules/inventory";
import { billingService } from "@/modules/billing";
import { computeTransferFingerprint } from "../domain/fingerprint";
import { InvalidTransferInputError, TransferIdempotencyKeyReuseError } from "../domain/errors";
import type { CreateTransferInput, TransferDto } from "./dto";
import type { TransfersRepository, InsertTransferLineInput } from "./ports";
import { toTransferDto } from "./mappers";

const createTransferSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, "quantity must be a positive decimal string"),
      })
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// createTransfer -- ONE atomic transaction (the caller's withTenantSession,
// via `ctx`; this function opens NO transaction of its own, same convention
// as confirmSale). Stock LEAVES the origin HERE, immediately -- it belongs
// to NEITHER store's stock_levels until `receiveTransfer` runs, possibly in
// a wholly separate request (db/README's in-transit invariant: in-transit
// quantity is a DERIVED figure, Σ lines of in_transit transfers, never a
// phantom warehouse row).
//
// Idempotency argument identical to confirmSale's: a transfer row only
// becomes visible to another transaction once THIS one commits, which only
// happens after the full create path (lock -> check -> post -> allocate
// reference -> audit) succeeds -- so `ON CONFLICT DO NOTHING` returning zero
// rows always means "a fully-created transfer already exists for this key",
// never a stray half-built one. The request fingerprint (same H1 defense as
// sales) is re-checked on every replay so a reused key with a DIFFERENT
// payload is rejected rather than silently returning the wrong transfer.
//
// Ordering note: stock_transfers has no separate "draft" status (unlike
// `sales`) -- the row is inserted with a PLACEHOLDER reference (derived
// from the idempotency key, so it can never collide with another in-flight
// attempt's placeholder) and finalized via `finalizeHeader` once the real,
// gapless reference has been allocated. This still claims the idempotency
// key BEFORE any side-effecting stock movement, exactly like confirmSale
// claims its draft before touching inventory.
// ---------------------------------------------------------------------------
export async function createTransfer(
  ctx: TenantSessionContext,
  rawInput: CreateTransferInput,
  repo: TransfersRepository
): Promise<TransferDto> {
  assertCan(ctx.actor, "transfer:create");
  const input = createTransferSchema.parse(rawInput);

  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new InvalidTransferInputError("The destination store must differ from the origin store.");
  }

  // A gérant may only create a transfer FROM their own store -- the
  // destination is intentionally NOT restricted the same way (a gérant
  // must be able to send stock to ANY other store in the tenant, not just
  // one they also happen to manage).
  assertStoreAccess(ctx.actor, input.fromWarehouseId);

  const distinctProductIds = new Set(input.lines.map((l) => l.productId));
  if (distinctProductIds.size !== input.lines.length) {
    throw new InvalidTransferInputError(
      "A transfer cannot list the same product on more than one line -- merge quantities into a single line."
    );
  }
  for (const line of input.lines) {
    if (!Quantity.fromString(line.quantity).isPositive()) {
      throw new InvalidTransferInputError(
        `Line quantity for product "${line.productId}" must be strictly positive.`
      );
    }
  }

  const requestFingerprint = computeTransferFingerprint({
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    lines: input.lines,
  });

  const draft = await repo.tryInsertDraft(ctx, {
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    // Placeholders -- `finalizeHeader` overwrites all three below, still
    // inside this SAME uncommitted transaction, before anything is
    // returned. The reference placeholder piggybacks on the idempotency
    // key's own uniqueness (structureId, idempotencyKey) so two concurrent
    // creates for DIFFERENT transfers never contend on the
    // (structureId, fiscalYear, reference) unique index while both are
    // mid-flight.
    currencyCode: "XOF",
    reference: `pending:${input.idempotencyKey}`,
    fiscalYear: 0,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    createdBy: ctx.actor.userId,
  });

  if (!draft) {
    const existing = await repo.findByIdempotencyKey(ctx, input.idempotencyKey);
    if (!existing) {
      throw new InvalidTransferInputError(
        "Could not create or find the transfer for this idempotency key -- retry."
      );
    }
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new TransferIdempotencyKeyReuseError();
    }
    const existingLines = await repo.listLines(ctx, existing.id);
    return toTransferDto(existing, existingLines, true);
  }

  // Re-read products server-side (existence + tenant currency) -- never
  // trust a client-sent currency/cost for this.
  const products = await Promise.all(input.lines.map((line) => catalogService.getProduct(ctx, line.productId)));
  const currencyCode = products[0]?.currencyCode ?? "XOF";

  // Ordered lock across (originWarehouseId, productId) pairs via
  // `lockLevelsForUpdateAcrossWarehouses` (see apply-transfer-out.ts header
  // comment for why this primitive is used even for a single-warehouse
  // call), availability check, "out" movement per line at the CURRENT
  // average cost (the CUMP snapshot this transfer line carries at
  // departure, carrying `transferId` -- the composite-FK column, never the
  // legacy polymorphic pair), stock_levels decrement. Throws
  // InsufficientStockError if any line would oversell the origin -- no
  // oversell override exists for transfers (unlike sales' stock:oversell),
  // per this phase's scope.
  const stockOutResult = await inventoryService.applyTransferOut(ctx, {
    warehouseId: input.fromWarehouseId,
    lines: input.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    transferId: draft.id,
  });

  const fiscalYear = new Date().getUTCFullYear();
  const referenceNumber = await billingService.allocateTransferReference(ctx, fiscalYear);
  const reference = `TR-${fiscalYear}-${referenceNumber.toString().padStart(6, "0")}`;

  const lineInserts: InsertTransferLineInput[] = input.lines.map((line, index) => ({
    productId: line.productId,
    quantity: Quantity.fromString(line.quantity),
    unitCostMinor: BigInt(stockOutResult.unitCostMinorByProductId[line.productId] ?? "0"),
    lineNo: index + 1,
  }));
  const insertedLines = await repo.insertLines(ctx, draft.id, lineInserts);

  const header = await repo.finalizeHeader(ctx, draft.id, { reference, fiscalYear, currencyCode });

  await ctx.audit.append({
    action: "transfer.created",
    targetType: "stock_transfer",
    targetId: draft.id,
    payload: {
      idempotencyKey: input.idempotencyKey,
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      lineCount: insertedLines.length,
      reference,
    },
  });

  return toTransferDto(header, insertedLines, false);
}
