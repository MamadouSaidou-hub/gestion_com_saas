import { z } from "zod";
import { assertCan, assertStoreAccess } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { inventoryService, Quantity } from "@/modules/inventory";
import { computeStockCountFingerprint } from "../domain/fingerprint";
import { InvalidStockCountInputError } from "../domain/errors";
import type { OpenStockCountInput, StockCountDto } from "./dto";
import type { StockCountsRepository, InsertStockCountLineInput } from "./ports";
import { toStockCountDto } from "./mappers";

const openStockCountSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  warehouseId: z.uuid(),
  productIds: z.array(z.uuid()).min(1),
});

// ---------------------------------------------------------------------------
// openStockCount -- "Select article(s) + store, show the theoretical
// quantity" (step 1 of the counting flow). Freezes `theoretical_qty` for
// every selected product AT THIS MOMENT (read from stock_levels, the
// derived projection -- fine for a snapshot, since the ledger is what the
// eventual VALIDATION adjusts against, not this frozen number). Separate
// transaction from `validateStockCount`, same two-step shape as
// createTransfer/receiveTransfer -- the physical count itself happens
// between these two requests, possibly hours later.
//
// Idempotency: same "insert draft, ON CONFLICT DO NOTHING" + fingerprint
// re-check pattern as every other idempotent write in this codebase. There
// is no stock-affecting side effect here (no movement is posted until
// validation) -- idempotency still matters because a retried "open" must
// not create a SECOND count sheet with a DIFFERENT theoretical snapshot
// for the same intended request.
// ---------------------------------------------------------------------------
export async function openStockCount(
  ctx: TenantSessionContext,
  rawInput: OpenStockCountInput,
  repo: StockCountsRepository
): Promise<StockCountDto> {
  assertCan(ctx.actor, "count:open");
  const input = openStockCountSchema.parse(rawInput);
  assertStoreAccess(ctx.actor, input.warehouseId);

  const distinctProductIds = new Set(input.productIds);
  if (distinctProductIds.size !== input.productIds.length) {
    throw new InvalidStockCountInputError("A stock count cannot list the same product more than once.");
  }

  const draft = await repo.tryInsertDraft(ctx, {
    warehouseId: input.warehouseId,
    idempotencyKey: input.idempotencyKey,
    createdBy: ctx.actor.userId,
  });

  if (!draft) {
    const existing = await repo.findByIdempotencyKey(ctx, input.idempotencyKey);
    if (!existing) {
      throw new InvalidStockCountInputError(
        "Could not open or find the stock count for this idempotency key -- retry."
      );
    }
    const existingLines = await repo.listLines(ctx, existing.id);
    const existingFingerprint = computeStockCountFingerprint({
      warehouseId: existing.warehouseId,
      productIds: existingLines.map((l) => l.productId),
    });
    const requestedFingerprint = computeStockCountFingerprint({
      warehouseId: input.warehouseId,
      productIds: input.productIds,
    });
    if (existingFingerprint !== requestedFingerprint) {
      throw new InvalidStockCountInputError(
        "This idempotency key was already used to open a different stock count -- generate a new key."
      );
    }
    return toStockCountDto(existing, existingLines, true);
  }

  const levels = await inventoryService.getStockLevels(ctx, { warehouseId: input.warehouseId });
  const quantityByProductId = new Map(levels.map((l) => [l.productId, l.quantity]));

  const lineInserts: InsertStockCountLineInput[] = input.productIds.map((productId) => ({
    productId,
    theoreticalQty: Quantity.fromString(quantityByProductId.get(productId) ?? "0.0000"),
  }));
  const insertedLines = await repo.insertLines(ctx, draft.id, lineInserts);

  await ctx.audit.append({
    action: "stock_count.opened",
    targetType: "stock_count",
    targetId: draft.id,
    payload: {
      idempotencyKey: input.idempotencyKey,
      warehouseId: input.warehouseId,
      productCount: insertedLines.length,
    },
  });

  return toStockCountDto(draft, insertedLines, false);
}
