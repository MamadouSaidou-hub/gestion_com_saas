import { assertCan, assertStoreAccess } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { inventoryService } from "@/modules/inventory";
import { TransferNotFoundError, TransferNotInTransitError } from "../domain/errors";
import type { TransferDto } from "./dto";
import type { TransfersRepository } from "./ports";
import { toTransferDto } from "./mappers";

// ---------------------------------------------------------------------------
// receiveTransfer -- the INCOMING leg, a SEPARATE transaction from
// createTransfer (the stock sits in neither store's stock_levels while
// `in_transit`, see db/README's invariant). Only the destination's own
// gérant (or an unscoped actor) may receive -- enforced below via
// `assertStoreAccess(ctx.actor, header.toWarehouseId)`, BEFORE anything
// else, same discipline as confirmSale checking warehouse access first.
//
// Double-receive guard: the UPDATE itself is the arbiter
// (`WHERE status = 'in_transit' RETURNING *`), not a separate
// find-then-check -- the SAME lesson as billing's `markVoided`. Two
// concurrent `receiveTransfer` calls for the SAME transfer can only ever
// have ONE of them see a non-empty `RETURNING`; the other's `rowCount` is
// 0 and it throws `TransferNotInTransitError`, never double-posting the
// incoming stock movement.
// ---------------------------------------------------------------------------
export async function receiveTransfer(
  ctx: TenantSessionContext,
  transferId: string,
  repo: TransfersRepository
): Promise<TransferDto> {
  assertCan(ctx.actor, "transfer:receive");

  const header = await repo.findById(ctx, transferId);
  if (!header) {
    throw new TransferNotFoundError(transferId);
  }
  assertStoreAccess(ctx.actor, header.toWarehouseId);

  const receivedAt = new Date();
  const updated = await repo.markReceived(ctx, transferId, ctx.actor.userId, receivedAt);
  if (!updated) {
    // Either already received, already cancelled, or (vanishingly
    // unlikely, given the findById above) raced out of existence -- all
    // three collapse to the same user-facing message, same as billing's
    // PaymentAlreadyVoidedError-style guard.
    throw new TransferNotInTransitError(transferId);
  }

  const lines = await repo.listLines(ctx, transferId);

  // "in" movements at the cost SNAPSHOTTED AT DEPARTURE
  // (`line.unitCostMinor`, taken by applyTransferOut when the transfer was
  // created) -- critically NOT the destination's current average, and NOT
  // a value recomputed here. `applyTransferIn` still blends this into the
  // destination's OWN moving average via the normal CUMP receipt formula
  // (same as `receiveStock`) -- that blend is what keeps an A->B->A round
  // trip from creating or destroying value; it is not the thing this rule
  // forbids (see apply-transfer-in.ts's header comment).
  await inventoryService.applyTransferIn(ctx, {
    warehouseId: header.toWarehouseId,
    transferId,
    currencyCode: header.currencyCode,
    lines: lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity.toDbString(),
      unitCostMinor: line.unitCostMinor,
    })),
  });

  await ctx.audit.append({
    action: "transfer.received",
    targetType: "stock_transfer",
    targetId: transferId,
    payload: {
      fromWarehouseId: header.fromWarehouseId,
      toWarehouseId: header.toWarehouseId,
      lineCount: lines.length,
    },
  });

  return toTransferDto(updated, lines, false);
}
