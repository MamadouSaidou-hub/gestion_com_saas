import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import { computeCumpOnReceipt } from "../domain/valuation";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface TransferInLine {
  productId: string;
  quantity: string; // numeric(18,4) string -- never a number
  // CUMP cost snapshot taken AT DEPARTURE (stock_transfer_lines.unit_cost_minor).
  // This is the price the destination store "paid" for these units -- it is
  // NEVER the destination's own current average, and it is NEVER recomputed
  // here; using anything else would let an A->B->A round trip create or
  // destroy value (see db/README's in-transit invariant).
  unitCostMinor: bigint;
}

export interface ApplyTransferInInput {
  warehouseId: string; // the transfer's destination store
  lines: TransferInLine[];
  transferId: string;
  currencyCode: string;
}

// ---------------------------------------------------------------------------
// applyTransferIn -- the INCOMING leg, posted when the destination store
// marks the transfer received (a transaction SEPARATE from applyTransferOut
// -- the goods sit in neither store's stock_levels while in transit, see
// db/README's in-transit invariant / `createTransfer`'s header comment).
//
// This is a normal CUMP receipt (`computeCumpOnReceipt`, same as
// `receiveStock`): the destination's moving average blends its existing
// stock with the incoming units AT THE DEPARTURE COST -- that blend is
// exactly what keeps a transfer's valuation consistent with a purchase at
// that price; it is not the thing the "never recompute the cost" rule
// forbids. What that rule forbids is substituting something OTHER than the
// departure snapshot as the movement's own unit_cost_minor (e.g. the
// destination's pre-existing average, or some other freshly-derived value)
// -- this function only ever uses `line.unitCostMinor` for that.
// ---------------------------------------------------------------------------
export async function applyTransferIn(
  ctx: TenantSessionContext,
  input: ApplyTransferInInput,
  repo: StockRepository
): Promise<StockMovementDto[]> {
  const pairs = input.lines.map((l) => ({ productId: l.productId, warehouseId: input.warehouseId }));
  const locked = await repo.lockLevelsForUpdateAcrossWarehouses(ctx, pairs);
  const byProductId = new Map(locked.map((level) => [level.productId, level]));

  const movements: StockMovementDto[] = [];

  for (const line of input.lines) {
    const quantity = Quantity.fromString(line.quantity);
    const current = byProductId.get(line.productId);
    const currentQty = current?.quantity ?? Quantity.zero();
    const currentAvgCost = current?.avgCostMinor ?? 0n;

    const newAvgCost = computeCumpOnReceipt(currentQty, currentAvgCost, quantity, line.unitCostMinor);
    const newQty = currentQty.add(quantity);

    const movement = await repo.insertMovement(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      direction: "in",
      quantity,
      unitCostMinor: line.unitCostMinor, // the departure snapshot -- never recomputed
      currencyCode: input.currencyCode,
      reason: "transfer_in",
      transferId: input.transferId,
    });

    await repo.upsertLevel(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      quantity: newQty,
      avgCostMinor: newAvgCost,
      currencyCode: input.currencyCode,
    });

    movements.push(toMovementDto(movement));
  }

  return movements;
}
