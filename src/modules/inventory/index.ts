import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { stockRepository } from "./infrastructure/stock-repository";
import * as useCases from "./application";
import type { ReceiveStockInput, AdjustStockInput, ApplyStockOutInput, ReverseStockOutInput } from "./application";
import type { ListLevelsFilter, ListMovementsFilter } from "./application";

// ---------------------------------------------------------------------------
// inventory/index.ts -- the ONLY surface another module is allowed to
// import from. Composition root: wires the concrete (drizzle) repository
// into the pure application use cases.
//
// `applyStockOut`/`reverseStockOut` take a caller-provided `ctx` and open
// NO transaction of their own -- sales' `confirmSale` (step 3 of this plan)
// will pass its own `TenantSessionContext` here, e.g.
// `inventoryService.applyStockOut(ctx, { ... })`, instead of ever importing
// `@/db/schema/inventory` directly.
//
// `Quantity` is re-exported here (not from `@/modules/inventory/domain`
// directly) so another module can construct/compare quantities -- e.g.
// sales validating a requested sale-line quantity -- without reaching past
// this module's public surface.
// ---------------------------------------------------------------------------

export const inventoryService = {
  receiveStock: (ctx: TenantSessionContext, input: ReceiveStockInput) =>
    useCases.receiveStock(ctx, input, stockRepository),
  adjustStock: (ctx: TenantSessionContext, input: AdjustStockInput) =>
    useCases.adjustStock(ctx, input, stockRepository),
  getStockLevels: (ctx: TenantSessionContext, filter: ListLevelsFilter) =>
    useCases.getStockLevels(ctx, filter, stockRepository),
  listMovements: (ctx: TenantSessionContext, filter: ListMovementsFilter) =>
    useCases.listMovements(ctx, filter, stockRepository),
  listLowStock: (ctx: TenantSessionContext, warehouseId: string) =>
    useCases.listLowStock(ctx, warehouseId, stockRepository),
  applyStockOut: (ctx: TenantSessionContext, input: ApplyStockOutInput) =>
    useCases.applyStockOut(ctx, input, stockRepository),
  reverseStockOut: (ctx: TenantSessionContext, input: ReverseStockOutInput) =>
    useCases.reverseStockOut(ctx, input, stockRepository),
  rebuildStockLevels: (ctx: TenantSessionContext) => useCases.rebuildStockLevels(ctx, stockRepository),
};

export { Quantity, InvalidQuantityError } from "./domain/quantity";
export { computeCumpOnReceipt } from "./domain/valuation";
export { InsufficientStockError, InvalidStockAdjustmentError } from "./domain/errors";
export type { StockLevelDto, StockMovementDto } from "./application";
export type {
  ReceiveStockInput,
  AdjustStockInput,
  ApplyStockOutInput,
  ApplyStockOutResult,
  ReverseStockOutInput,
  ListLevelsFilter,
  ListMovementsFilter,
  LowStockAlert,
  RebuildStockLevelsResult,
} from "./application";
