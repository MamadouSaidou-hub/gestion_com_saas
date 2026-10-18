import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import { InsufficientStockError, InvalidStockAdjustmentError } from "../domain/errors";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface AdjustStockInput {
  productId: string;
  warehouseId: string;
  direction: "in" | "out";
  quantity: string; // numeric(18,4) string -- never a number
  currencyCode: string;
  // Mandatory per CLAUDE.md's audit discipline -- a manual stock adjustment
  // with no stated reason is not auditable in any meaningful sense.
  reason: string;
}

// A manual adjustment (stock count correction, breakage, loss, found stock)
// never touches the CUMP moving average -- only `receiveStock` (a real
// purchase) does that. An "in" adjustment restores quantity at the
// EXISTING average cost; an "out" adjustment removes quantity, average
// unchanged either way.
export async function adjustStock(
  ctx: TenantSessionContext,
  input: AdjustStockInput,
  repo: StockRepository
): Promise<StockMovementDto> {
  assertCan(ctx.actor, "stock:adjust");

  if (input.reason.trim().length === 0) {
    throw new InvalidStockAdjustmentError("A reason is mandatory for a manual stock adjustment.");
  }

  const quantity = Quantity.fromString(input.quantity);
  if (!quantity.isPositive()) {
    throw new InvalidStockAdjustmentError("Adjustment quantity must be strictly positive.");
  }

  // H3 fix (security-reviewer, High): was `repo.getLevel` (no lock) then
  // an absolute-value `upsertLevel` write -- a concurrent sale's
  // stock-out (locked via `applyStockOut`) could land between this read
  // and the write, and this adjustment would overwrite the sale's
  // decrement with a stale value, inflating available stock and
  // neutralising the oversell guard for whoever sells next. Locking here
  // serializes against that same row lock.
  const [current] = await repo.lockLevelsForUpdate(ctx, input.warehouseId, [input.productId]);
  const currentQty = current?.quantity ?? Quantity.zero();
  const currentAvgCost = current?.avgCostMinor ?? 0n;

  if (input.direction === "out" && currentQty.lessThan(quantity)) {
    throw new InsufficientStockError([
      {
        productId: input.productId,
        warehouseId: input.warehouseId,
        available: currentQty.toDbString(),
        requested: quantity.toDbString(),
      },
    ]);
  }

  const newQty = input.direction === "in" ? currentQty.add(quantity) : currentQty.subtract(quantity);

  const movement = await repo.insertMovement(ctx, {
    productId: input.productId,
    warehouseId: input.warehouseId,
    direction: input.direction,
    quantity,
    unitCostMinor: currentAvgCost, // snapshot only, not a new cost basis
    currencyCode: input.currencyCode,
    reason: `adjustment:${input.reason}`,
  });

  await repo.upsertLevel(ctx, {
    productId: input.productId,
    warehouseId: input.warehouseId,
    quantity: newQty,
    avgCostMinor: currentAvgCost,
    currencyCode: input.currencyCode,
  });

  await ctx.audit.append({
    action: "stock.adjusted",
    targetType: "product",
    targetId: input.productId,
    payload: {
      warehouseId: input.warehouseId,
      movementId: movement.id.toString(),
      direction: input.direction,
      quantity: quantity.toDbString(),
      reason: input.reason,
    },
  });

  return toMovementDto(movement);
}
