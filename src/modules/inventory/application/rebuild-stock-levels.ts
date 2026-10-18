import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import { computeCumpOnReceipt } from "../domain/valuation";
import type { StockRepository } from "./ports";

export interface RebuildStockLevelsResult {
  productCount: number;
}

// ---------------------------------------------------------------------------
// rebuildStockLevels -- H3 fix (security-reviewer, High): `stock:rebuild`
// has been in the permission matrix since Phase 1 step 1 with no use
// case implementing it, even though `stock_movements` (the ledger) is the
// designated source of truth (D9) and `stock_levels` is explicitly a
// derived, recomputable PROJECTION. Owner-only (the matrix already
// reserves `stock:rebuild` to owner).
//
// For every (product, warehouse) pair that has ever had a movement,
// replays the FULL ledger in chronological order: an 'in' movement
// updates both quantity and the CUMP moving average (via the SAME pure
// `computeCumpOnReceipt` function `receiveStock` uses); an 'out'
// movement only changes quantity, never the average (D9). The final
// recomputed (quantity, avgCostMinor) OVERWRITES whatever `stock_levels`
// currently holds for that pair -- that overwrite is the intended effect
// of a rebuild, not a race (this is a deliberate, owner-invoked, full
// recompute from the ledger, not a read-modify-write of a live balance).
//
// Known limitation, documented rather than engineered around given the
// scope of this fix: a rebuild running concurrently with live sales is a
// best-effort snapshot of the ledger at the time each pair is read, not
// a frozen point-in-time view of the whole structure. Acceptable for a
// maintenance operation an owner runs occasionally when the projection is
// suspected to have drifted, not part of the normal sales hot path.
// ---------------------------------------------------------------------------
export async function rebuildStockLevels(
  ctx: TenantSessionContext,
  repo: StockRepository
): Promise<RebuildStockLevelsResult> {
  assertCan(ctx.actor, "stock:rebuild");

  const pairs = await repo.listDistinctProductWarehousePairs(ctx);

  for (const pair of pairs) {
    const movements = await repo.listAllMovementsForRebuild(ctx, pair.productId, pair.warehouseId);

    let quantity = Quantity.zero();
    let avgCostMinor = 0n;
    for (const movement of movements) {
      if (movement.direction === "in") {
        avgCostMinor = computeCumpOnReceipt(quantity, avgCostMinor, movement.quantity, movement.unitCostMinor);
        quantity = quantity.add(movement.quantity);
      } else {
        quantity = quantity.subtract(movement.quantity);
      }
    }

    await repo.upsertLevel(ctx, {
      productId: pair.productId,
      warehouseId: pair.warehouseId,
      quantity,
      avgCostMinor,
      currencyCode: movements[movements.length - 1]?.currencyCode ?? "XOF",
    });
  }

  await ctx.audit.append({
    action: "stock.rebuilt",
    targetType: "warehouse",
    targetId: null,
    payload: { productCount: pairs.length },
  });

  return { productCount: pairs.length };
}
