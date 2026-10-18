import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { stockRepository } from "./infrastructure/stock-repository";
import * as useCases from "./application";
import type { ReceiveStockInput, AdjustStockInput, ApplyStockOutInput, ReverseStockOutInput } from "./application";
import type { ListLevelsFilter, ListMovementsFilter } from "./application";
import type { ApplyTransferOutInput, ApplyTransferInInput, ApplyStockCountAdjustmentInput } from "./application";

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
  // multi-store: `storeScope` is REQUIRED -- `null` = every store the actor
  // can see (resolved by the caller via `resolveStoreScope`, never guessed
  // here).
  listLowStock: (ctx: TenantSessionContext, storeScope: string | null) =>
    useCases.listLowStock(ctx, stockRepository, storeScope),
  applyStockOut: (ctx: TenantSessionContext, input: ApplyStockOutInput) =>
    useCases.applyStockOut(ctx, input, stockRepository),
  reverseStockOut: (ctx: TenantSessionContext, input: ReverseStockOutInput) =>
    useCases.reverseStockOut(ctx, input, stockRepository),
  // `warehouseId` optional -- `null`/omitted rebuilds EVERY (product,
  // warehouse) pair in the tenant (unchanged default behaviour), a real id
  // restricts the rebuild to one store's pairs only.
  rebuildStockLevels: (ctx: TenantSessionContext, warehouseId?: string | null) =>
    useCases.rebuildStockLevels(ctx, stockRepository, warehouseId ?? null),
  // --- inter-store transfers / physical counts (this phase) -- ctx-based
  // primitives the stock-transfers module calls with ITS OWN ctx, same
  // cross-module convention as billing calling sales' primitives. ---
  applyTransferOut: (ctx: TenantSessionContext, input: ApplyTransferOutInput) =>
    useCases.applyTransferOut(ctx, input, stockRepository),
  applyTransferIn: (ctx: TenantSessionContext, input: ApplyTransferInInput) =>
    useCases.applyTransferIn(ctx, input, stockRepository),
  applyStockCountAdjustment: (ctx: TenantSessionContext, input: ApplyStockCountAdjustmentInput) =>
    useCases.applyStockCountAdjustment(ctx, input, stockRepository),
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
  ApplyTransferOutInput,
  ApplyTransferOutResult,
  TransferOutLine,
  ApplyTransferInInput,
  TransferInLine,
  ApplyStockCountAdjustmentInput,
  StockCountAdjustmentResult,
  StockCountVarianceLine,
} from "./application";
