import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface ReverseStockOutLine {
  productId: string;
  quantity: string;
  unitCostMinor: bigint; // the cost the original stock-out was recorded at
}

export interface ReverseStockOutInput {
  warehouseId: string;
  lines: ReverseStockOutLine[];
  reason: string; // e.g. 'sale_void', 'transfer_cancelled'
  saleId?: string | null;
  // Mutually exclusive with saleId -- `cancelTransfer` (this phase) passes
  // this instead, never both (stock_movements_exclusive_arc_chk enforces it
  // at the DB level regardless of what the caller intends).
  transferId?: string | null;
  currencyCode: string;
}

// ---------------------------------------------------------------------------
// reverseStockOut -- compensating entry for a cancelled/voided sale (or any
// other reversed stock-out). Takes a CALLER-PROVIDED `ctx` and MUST NOT open
// its own transaction, same convention as applyStockOut.
//
// Deliberately does NOT call computeCumpOnReceipt: a reversal restores the
// ledger to the state it would be in had the original stock-out never
// happened, at the cost it was removed at -- it is not a new purchase, so it
// must not pull the moving average toward today's incoming cost. No
// permission check beyond what the caller (e.g. sales' void use case,
// gated on `sale:void`) already enforced -- this function's only job is the
// stock-side compensation of an already-authorized action.
//
// M-b fix (security-reviewer follow-up): locks via `lockLevelsForUpdate`
// before reading, same as `adjustStock`/`receiveStock` (H3) -- this
// function has no caller yet (no `voidSale` use case exists), but it IS
// already on the module's public surface (`inventory/index.ts`), so it
// would otherwise reintroduce H3's exact lost-update race (unlocked read
// then an absolute `upsertLevel` write) the moment someone wires a
// cancelled-sale flow against it.
// ---------------------------------------------------------------------------
export async function reverseStockOut(
  ctx: TenantSessionContext,
  input: ReverseStockOutInput,
  repo: StockRepository
): Promise<StockMovementDto[]> {
  const movements: StockMovementDto[] = [];
  const sortedProductIds = [...input.lines.map((l) => l.productId)].sort();
  const locked = await repo.lockLevelsForUpdate(ctx, input.warehouseId, sortedProductIds);
  const byProductId = new Map(locked.map((level) => [level.productId, level]));

  for (const line of input.lines) {
    const quantity = Quantity.fromString(line.quantity);
    const current = byProductId.get(line.productId);
    const currentQty = current?.quantity ?? Quantity.zero();
    const currentAvgCost = current?.avgCostMinor ?? line.unitCostMinor;

    const movement = await repo.insertMovement(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      direction: "in",
      quantity,
      unitCostMinor: line.unitCostMinor,
      currencyCode: input.currencyCode,
      reason: input.reason,
      saleId: input.saleId ?? null,
      transferId: input.transferId ?? null,
    });

    await repo.upsertLevel(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      quantity: currentQty.add(quantity),
      avgCostMinor: currentAvgCost, // unchanged -- see header comment
      currencyCode: input.currencyCode,
    });

    movements.push(toMovementDto(movement));
  }

  return movements;
}
