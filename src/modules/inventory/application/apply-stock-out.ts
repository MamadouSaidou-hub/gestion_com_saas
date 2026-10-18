import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import { InsufficientStockError, type StockShortage } from "../domain/errors";
import type { StockRepository } from "./ports";
import type { StockMovementDto } from "./dto";
import { toMovementDto } from "./mappers";

export interface StockOutLine {
  productId: string;
  quantity: string; // numeric(18,4) string -- never a number
  unitCostMinorAtRemoval?: bigint; // only needed by callers that already locked/read the level themselves
}

export interface ApplyStockOutInput {
  warehouseId: string;
  lines: StockOutLine[];
  reason: string; // e.g. 'sale', 'transfer_out'
  saleId?: string | null;
  // Explicit, per-operation override -- block-by-default (approved product
  // decision). Only an actor holding `stock:oversell` (manager/owner) may
  // set this to true; `assertCan` below enforces that, it is never implied
  // by the caller's own permission to create a sale.
  allowOversell?: boolean;
}

export interface ApplyStockOutResult {
  movements: StockMovementDto[];
  // Cost snapshot per product at the moment of removal -- callers (sales,
  // in step 3) need this to populate sale_lines.unit_cost_minor; a stock-out
  // never changes the average, so this IS the average both before and
  // after this call.
  unitCostMinorByProductId: Record<string, string>;
}

// ---------------------------------------------------------------------------
// applyStockOut -- takes a CALLER-PROVIDED `ctx` (a `TenantSessionContext`
// already opened by the top-level use case, e.g. sales' `confirmSale` in a
// later step) and MUST NOT open its own transaction. This is the
// "inventoryService.applyStockOut(ctx, ...)" call sales will make instead
// of ever importing @/db/schema/inventory directly (hard cross-module
// boundary rule).
//
// Locks `stock_levels` rows FOR UPDATE ordered by productId BEFORE checking
// availability -- the caller is responsible for passing `lines` already
// sorted, or this function sorts them itself (it does, below), so two
// concurrent calls against overlapping product sets can never deadlock
// against each other regardless of the order the caller listed products in.
// ---------------------------------------------------------------------------
export async function applyStockOut(
  ctx: TenantSessionContext,
  input: ApplyStockOutInput,
  repo: StockRepository
): Promise<ApplyStockOutResult> {
  if (input.allowOversell) {
    assertCan(ctx.actor, "stock:oversell");
  }

  const sortedProductIds = [...input.lines.map((l) => l.productId)].sort();
  const locked = await repo.lockLevelsForUpdate(ctx, input.warehouseId, sortedProductIds);
  const byProductId = new Map(locked.map((level) => [level.productId, level]));

  // M5 fix (security-reviewer, Medium): `wasShort` is computed
  // REGARDLESS of `allowOversell` -- it's what lets the audit entry below
  // record exactly which lines a real shortage was crossed for (and by
  // how much), instead of firing unconditionally whenever the flag is set
  // (which diluted the signal: most oversell-enabled calls sell products
  // that were never actually short).
  const shortages: StockShortage[] = [];
  const parsedLines = input.lines.map((line) => {
    const requested = Quantity.fromString(line.quantity);
    const level = byProductId.get(line.productId);
    const available = level?.quantity ?? Quantity.zero();
    const wasShort = available.lessThan(requested);
    if (!input.allowOversell && wasShort) {
      shortages.push({
        productId: line.productId,
        warehouseId: input.warehouseId,
        available: available.toDbString(),
        requested: requested.toDbString(),
      });
    }
    return { line, requested, available, wasShort, avgCostMinor: level?.avgCostMinor ?? 0n };
  });

  if (shortages.length > 0) {
    throw new InsufficientStockError(shortages);
  }

  const movements: StockMovementDto[] = [];
  const unitCostMinorByProductId: Record<string, string> = {};
  const overriddenShortages: Array<{
    productId: string;
    available: string;
    requested: string;
    resultingQuantity: string;
  }> = [];

  for (const { line, requested, available, wasShort, avgCostMinor } of parsedLines) {
    const newQty = available.subtract(requested);
    if (wasShort) {
      overriddenShortages.push({
        productId: line.productId,
        available: available.toDbString(),
        requested: requested.toDbString(),
        resultingQuantity: newQty.toDbString(),
      });
    }
    const movement = await repo.insertMovement(ctx, {
      productId: line.productId,
      warehouseId: input.warehouseId,
      direction: "out",
      quantity: requested,
      unitCostMinor: avgCostMinor, // stock-out never changes the average (D9)
      currencyCode: byProductId.get(line.productId)?.currencyCode ?? "XOF",
      reason: input.reason,
      saleId: input.saleId ?? null,
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

  // M5 fix: only emit this entry when a real shortage was actually
  // crossed (overriddenShortages non-empty), with per-line detail
  // (available/requested/resultingQuantity) instead of just a bare list
  // of productIds for every line regardless of whether oversell was
  // needed at all.
  if (overriddenShortages.length > 0) {
    await ctx.audit.append({
      action: "stock.oversell_override",
      targetType: "warehouse",
      targetId: input.warehouseId,
      payload: {
        reason: input.reason,
        saleId: input.saleId ?? null,
        shortages: overriddenShortages,
      },
    });
  }

  return { movements, unitCostMinorByProductId };
}
