import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import { computeCumpOnReceipt } from "../domain/valuation";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface DeliveryInLine {
  productId: string;
  quantity: string; // numeric(18,4) string -- never a number
  unitCostMinor: bigint; // the delivery line's own unit cost (what was actually paid)
}

export interface ApplyDeliveryInInput {
  warehouseId: string;
  lines: DeliveryInLine[];
  supplierDeliveryId: string;
  currencyCode: string;
}

// ---------------------------------------------------------------------------
// applyDeliveryIn -- the "in" leg of a supplier delivery, called from
// purchasing's recordDelivery(ctx, ...) with the SAME transaction ctx (the
// cross-module convention already used by confirmSale ->
// inventoryService.applyStockOut and createTransfer ->
// inventoryService.applyTransferOut/applyTransferIn). This is what
// ACTUALLY feeds CUMP (D9): a normal weighted-average receipt, same
// `computeCumpOnReceipt` used by receiveStock/applyTransferIn, at the
// delivery line's own unit cost -- never recomputed, never trusted from
// anywhere else.
//
// Ordered lock across all lines' (productId, warehouseId) pairs in ONE
// statement (`lockLevelsForUpdateAcrossWarehouses`), same deadlock-avoidance
// discipline as every other multi-line stock-in use case in this module.
// ---------------------------------------------------------------------------
export async function applyDeliveryIn(
  ctx: TenantSessionContext,
  input: ApplyDeliveryInInput,
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
      unitCostMinor: line.unitCostMinor,
      currencyCode: input.currencyCode,
      reason: "supplier_delivery",
      supplierDeliveryId: input.supplierDeliveryId,
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
