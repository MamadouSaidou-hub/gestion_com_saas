import { z } from "zod";
import { assertCan, assertStoreAccess } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto } from "@/platform/dto/money";
import { catalogService } from "@/modules/catalog";
import { inventoryService, Quantity } from "@/modules/inventory";
import { computeVarianceValueMinor } from "../domain/valuation";
import { StockCountNotFoundError, StockCountNotDraftError, InvalidStockCountInputError } from "../domain/errors";
import type { ValidateStockCountInput, StockCountDto } from "./dto";
import type { StockCountsRepository, StockCountLineResultPatch } from "./ports";
import { toStockCountDto } from "./mappers";

const validateStockCountSchema = z.object({
  stockCountId: z.uuid(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        countedQty: z.string().regex(/^\d+(\.\d{1,4})?$/, "countedQty must be a non-negative decimal string"),
      })
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// validateStockCount -- step 2 of the counting flow. ONE transaction: the
// header UPDATE (`WHERE status = 'draft' RETURNING *`) is the double-
// validation arbiter, run FIRST -- same lesson as receiveTransfer/
// billing's markVoided, so two concurrent validations of the SAME count
// can only ever have one of them proceed to post ledger movements.
//
// For every line with a NON-ZERO variance, posts exactly one ledger
// movement (`applyStockCountAdjustment`, direction per the sign) at the
// product's CURRENT average cost -- read live, at validation time, never
// the stale value captured when the count was opened. `stock_levels` is
// NEVER updated directly here or anywhere in that call; it only ever moves
// through the SAME ledger-then-projection path as every other inventory
// write (D9).
// ---------------------------------------------------------------------------
export async function validateStockCount(
  ctx: TenantSessionContext,
  rawInput: ValidateStockCountInput,
  repo: StockCountsRepository
): Promise<StockCountDto> {
  assertCan(ctx.actor, "count:validate");
  const input = validateStockCountSchema.parse(rawInput);

  const header = await repo.findById(ctx, input.stockCountId);
  if (!header) {
    throw new StockCountNotFoundError(input.stockCountId);
  }
  assertStoreAccess(ctx.actor, header.warehouseId);

  const existingLines = await repo.listLines(ctx, input.stockCountId);
  const existingByProductId = new Map(existingLines.map((l) => [l.productId, l]));

  const distinctProductIds = new Set(input.lines.map((l) => l.productId));
  if (distinctProductIds.size !== input.lines.length) {
    throw new InvalidStockCountInputError("A stock count cannot list the same product more than once.");
  }
  for (const line of input.lines) {
    if (!existingByProductId.has(line.productId)) {
      throw new InvalidStockCountInputError(
        `Product "${line.productId}" was not part of this stock count's opened lines.`
      );
    }
  }

  const validatedAt = new Date();
  const updated = await repo.markValidated(ctx, input.stockCountId, ctx.actor.userId, validatedAt);
  if (!updated) {
    throw new StockCountNotDraftError(input.stockCountId);
  }

  // Build the signed variance per line -- countedQty (just submitted)
  // minus theoreticalQty (frozen at `openStockCount`).
  const varianceByProductId = new Map<string, Quantity>();
  for (const line of input.lines) {
    const existing = existingByProductId.get(line.productId)!;
    const counted = Quantity.fromString(line.countedQty);
    const variance = counted.subtract(existing.theoreticalQty);
    varianceByProductId.set(line.productId, variance);
  }

  const nonZeroLines = [...varianceByProductId.entries()].filter(([, variance]) => !variance.isZero());

  // `stock_counts` carries no currencyCode column of its own (unlike
  // `stock_transfers`) -- the tenant has exactly one currency (D8), so any
  // product in the count is a correct source for it.
  const adjustmentResult =
    nonZeroLines.length > 0
      ? await (async () => {
          const anyProduct = await catalogService.getProduct(ctx, input.lines[0].productId);
          return inventoryService.applyStockCountAdjustment(ctx, {
            warehouseId: header.warehouseId,
            stockCountId: input.stockCountId,
            currencyCode: anyProduct.currencyCode,
            lines: nonZeroLines.map(([productId, variance]) => ({ productId, varianceQty: variance.toDbString() })),
          });
        })()
      : { movements: [], unitCostMinorByProductId: {} };

  const patches: StockCountLineResultPatch[] = input.lines.map((line) => {
    const variance = varianceByProductId.get(line.productId)!;
    const unitCostMinorStr = adjustmentResult.unitCostMinorByProductId[line.productId];
    const unitCostMinor = unitCostMinorStr !== undefined ? BigInt(unitCostMinorStr) : 0n;
    const varianceValueMinor = computeVarianceValueMinor(variance, unitCostMinor);
    return {
      productId: line.productId,
      countedQty: Quantity.fromString(line.countedQty),
      varianceQty: variance,
      unitCostMinor,
      varianceValueMinor,
    };
  });

  await repo.patchLineResults(ctx, input.stockCountId, patches);

  // ids + amounts only (M6 audit PII guard throws on a phone/email-shaped key).
  await ctx.audit.append({
    action: "stock_count.validated",
    targetType: "stock_count",
    targetId: input.stockCountId,
    payload: {
      warehouseId: header.warehouseId,
      variances: patches
        .filter((p) => !p.varianceQty.isZero())
        .map((p) => ({
          productId: p.productId,
          varianceQty: p.varianceQty.toDbString(),
          varianceValueMinor: moneyToDto(p.varianceValueMinor),
        })),
    },
  });

  const finalLines = await repo.listLines(ctx, input.stockCountId);
  return toStockCountDto(updated, finalLines, false);
}
