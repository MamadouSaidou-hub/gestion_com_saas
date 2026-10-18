import { assertCan, assertStoreAccess } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { inventoryService } from "@/modules/inventory";
import { TransferNotFoundError, TransferNotInTransitError } from "../domain/errors";
import type { CancelTransferInput, TransferDto } from "./dto";
import type { TransfersRepository } from "./ports";
import { toTransferDto } from "./mappers";

// ---------------------------------------------------------------------------
// cancelTransfer -- only while `in_transit` (same UPDATE-as-arbiter guard
// as receiveTransfer -- `WHERE status = 'in_transit' RETURNING *`). Writes
// a REVERSING "in" movement back to the ORIGIN, at the SAME cost the stock
// left at -- the ledger is never edited or deleted, only compensated
// forward (same discipline as inventory's reverseStockOut, which this use
// case calls directly with `transferId` instead of `saleId`).
//
// Scoping: either the origin OR the destination gérant may cancel (a
// gérant who realizes they sent the wrong store/quantity should not need
// to call the other store's gérant to undo it) -- enforced as "actor's
// store scope, if any, must be one of the transfer's two legs", NOT a
// hard requirement that it be the origin specifically.
// ---------------------------------------------------------------------------
export async function cancelTransfer(
  ctx: TenantSessionContext,
  input: CancelTransferInput,
  repo: TransfersRepository
): Promise<TransferDto> {
  assertCan(ctx.actor, "transfer:cancel");

  const header = await repo.findById(ctx, input.transferId);
  if (!header) {
    throw new TransferNotFoundError(input.transferId);
  }

  if (ctx.actor.warehouseId !== null) {
    const isParty = ctx.actor.warehouseId === header.fromWarehouseId || ctx.actor.warehouseId === header.toWarehouseId;
    if (!isParty) {
      // Reuses assertStoreAccess's ForbiddenError shape/message for a
      // store that is neither leg -- a store-scoped actor can never act on
      // a transfer that doesn't touch their own store at all.
      assertStoreAccess(ctx.actor, header.fromWarehouseId);
    }
  }

  const cancelledAt = new Date();
  const updated = await repo.markCancelled(ctx, input.transferId, ctx.actor.userId, cancelledAt, input.reason);
  if (!updated) {
    throw new TransferNotInTransitError(input.transferId);
  }

  const lines = await repo.listLines(ctx, input.transferId);

  await inventoryService.reverseStockOut(ctx, {
    warehouseId: header.fromWarehouseId,
    reason: "transfer_cancelled",
    transferId: input.transferId,
    currencyCode: header.currencyCode,
    lines: lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity.toDbString(),
      unitCostMinor: line.unitCostMinor,
    })),
  });

  await ctx.audit.append({
    action: "transfer.cancelled",
    targetType: "stock_transfer",
    targetId: input.transferId,
    payload: {
      fromWarehouseId: header.fromWarehouseId,
      toWarehouseId: header.toWarehouseId,
      lineCount: lines.length,
      reason: input.reason,
    },
  });

  return toTransferDto(updated, lines, false);
}
