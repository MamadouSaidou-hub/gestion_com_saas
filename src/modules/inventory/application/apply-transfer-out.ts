import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import { InsufficientStockError, type StockShortage } from "../domain/errors";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface TransferOutLine {
  productId: string;
  quantity: string; // numeric(18,4) string -- never a number
}

export interface ApplyTransferOutInput {
  warehouseId: string; // the transfer's origin store
  lines: TransferOutLine[];
  transferId: string;
}

export interface ApplyTransferOutResult {
  movements: StockMovementDto[];
  // CUMP cost snapshot AT DEPARTURE, per product -- the caller (transfers
  // module) persists this on stock_transfer_lines.unit_cost_minor so the
  // receiving store posts its "in" movement at the SAME cost later,
  // whenever that turns out to be (receiveTransfer is a SEPARATE
  // transaction, possibly hours/days later).
  unitCostMinorByProductId: Record<string, string>;
}

// ---------------------------------------------------------------------------
// applyTransferOut -- the OUTGOING leg of an inter-store transfer, posted at
// transfer CREATION time (stock leaves the origin immediately; it belongs to
// NEITHER store's stock_levels while `in_transit` -- see db/README's
// in-transit invariant). Takes a CALLER-PROVIDED `ctx` (the transfers
// module's own `createTransfer`, which opens the transaction) and MUST NOT
// open one of its own -- same convention as applyStockOut/adjustStock.
//
// Locks via `lockLevelsForUpdateAcrossWarehouses` (db/README entry 2x),
// even though THIS call only ever touches ONE warehouse (the origin) --
// per the explicit instruction that primitive exists so the ordering is
// uniform across every caller that ever locks stock_levels for a transfer
// leg, not just the ones that happen to span two warehouses in the SAME
// transaction. Using the single-warehouse `lockLevelsForUpdate` here would
// still be correct for THIS call in isolation, but would reintroduce two
// different lock-acquisition code paths for the same table family, which is
// exactly the kind of inconsistency that produced the 0010/0011/0012
// "fixed across three follow-ups" pattern db/README's entry 2x warns against.
//
// A stock-out never changes the average cost (D9) -- the snapshot returned
// here IS the average both before and after this call, exactly like
// applyStockOut.
// ---------------------------------------------------------------------------
export async function applyTransferOut(
  ctx: TenantSessionContext,
  input: ApplyTransferOutInput,
  repo: StockRepository
): Promise<ApplyTransferOutResult> {
  const pairs = input.lines.map((l) => ({ productId: l.productId, warehouseId: input.warehouseId }));
  const locked = await repo.lockLevelsForUpdateAcrossWarehouses(ctx, pairs);
  const byProductId = new Map(locked.map((level) => [level.productId, level]));

  const shortages: StockShortage[] = [];
  const parsedLines = input.lines.map((line) => {
    const requested = Quantity.fromString(line.quantity);
    const level = byProductId.get(line.productId);
    const available = level?.quantity ?? Quantity.zero();
    if (available.lessThan(requested)) {
      shortages.push({
        productId: line.productId,
        warehouseId: input.warehouseId,
        available: available.toDbString(),
        requested: requested.toDbString(),
      });
    }
    return { line, requested, available, avgCostMinor: level?.avgCostMinor ?? 0n };
  });

  if (shortages.length > 0) {
    throw new InsufficientStockError(shortages);
  }

  const movements: StockMovementDto[] = [];
  const unitCostMinorByProductId: Record<string, string> = {};

  for (const { line, requested, available, avgCostMinor } of parsedLines) {
    const newQty = available.subtract(requested);
    const movement = await repo.insertMovement(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      direction: "out",
      quantity: requested,
      unitCostMinor: avgCostMinor, // stock-out never changes the average (D9)
      currencyCode: byProductId.get(line.productId)?.currencyCode ?? "XOF",
      reason: "transfer_out",
      transferId: input.transferId,
    });
    await repo.upsertLevel(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      quantity: newQty,
      avgCostMinor,
      currencyCode: byProductId.get(line.productId)?.currencyCode ?? "XOF",
    });
    movements.push(toMovementDto(movement));
    unitCostMinorByProductId[line.productId] = avgCostMinor.toString();
  }

  return { movements, unitCostMinorByProductId };
}
