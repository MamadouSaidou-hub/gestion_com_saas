import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto, moneyFromDto, type MoneyMinorDto } from "@/platform/dto/money";
import { Quantity } from "../domain/quantity";
import { computeCumpOnReceipt } from "../domain/valuation";
import { InvalidStockAdjustmentError } from "../domain/errors";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface ReceiveStockInput {
  productId: string;
  warehouseId: string;
  quantity: string; // numeric(18,4) string -- never a number
  unitCostMinor: MoneyMinorDto;
  currencyCode: string;
  reason?: string; // default 'purchase'
}

// Top-level use case for inventory's OWN "receive stock" operation (called
// from the inventory module's own Server Action, which opens
// withTenantSession itself and passes the resulting ctx here). Updates the
// CUMP moving average -- the only kind of movement allowed to do so (D9).
export async function receiveStock(
  ctx: TenantSessionContext,
  input: ReceiveStockInput,
  repo: StockRepository
): Promise<StockMovementDto> {
  assertCan(ctx.actor, "stock:receive");

  const quantity = Quantity.fromString(input.quantity);
  if (!quantity.isPositive()) {
    throw new InvalidStockAdjustmentError("Received quantity must be strictly positive.");
  }
  const unitCostMinor = moneyFromDto(input.unitCostMinor);

  // H3 fix (security-reviewer, High): was `repo.getLevel` (a plain SELECT,
  // no lock) -- a concurrent sale's stock-out (which DOES lock via
  // applyStockOut's `lockLevelsForUpdate`) could commit between this read
  // and the `upsertLevel` write below, and this receipt's absolute-value
  // write would silently overwrite/lose the sale's decrement. Locking
  // here too means both operations serialize on the SAME row lock
  // `applyStockOut` already uses, instead of one clobbering the other.
  const [current] = await repo.lockLevelsForUpdate(ctx, input.warehouseId, [input.productId]);
  const currentQty = current?.quantity ?? Quantity.zero();
  const currentAvgCost = current?.avgCostMinor ?? 0n;

  const newAvgCost = computeCumpOnReceipt(currentQty, currentAvgCost, quantity, unitCostMinor);
  const newQty = currentQty.add(quantity);

  const movement = await repo.insertMovement(ctx, {
    productId: input.productId,
    warehouseId: input.warehouseId,
    direction: "in",
    quantity,
    unitCostMinor,
    currencyCode: input.currencyCode,
    reason: input.reason ?? "purchase",
  });

  await repo.upsertLevel(ctx, {
    productId: input.productId,
    warehouseId: input.warehouseId,
    quantity: newQty,
    avgCostMinor: newAvgCost,
    currencyCode: input.currencyCode,
  });

  // ids + amounts only (M6 audit PII guard throws on a phone/email-shaped key).
  await ctx.audit.append({
    action: "stock.received",
    targetType: "product",
    targetId: input.productId,
    payload: {
      warehouseId: input.warehouseId,
      movementId: movement.id.toString(),
      quantity: quantity.toDbString(),
      unitCostMinor: moneyToDto(unitCostMinor),
      newAvgCostMinor: moneyToDto(newAvgCost),
    },
  });

  return toMovementDto(movement);
}
