import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { Quantity } from "../domain/quantity";

// Domain-shaped records (bigint money, Quantity value object) -- what the
// application layer and repository implementation exchange. Mapped to
// StockLevelDto/StockMovementDto (application/dto.ts) only at the use
// case's return boundary.

export interface StockLevelRecord {
  structureId: string;
  productId: string;
  warehouseId: string;
  quantity: Quantity;
  avgCostMinor: bigint;
  currencyCode: string;
  updatedAt: Date;
}

export interface StockMovementRecord {
  id: bigint;
  structureId: string;
  productId: string;
  warehouseId: string;
  direction: "in" | "out";
  quantity: Quantity;
  unitCostMinor: bigint;
  currencyCode: string;
  reason: string;
  saleId: string | null;
  occurredAt: Date;
  createdBy: string;
}

export interface InsertMovementInput {
  productId: string;
  warehouseId: string;
  direction: "in" | "out";
  quantity: Quantity;
  unitCostMinor: bigint;
  currencyCode: string;
  reason: string;
  saleId?: string | null;
}

export interface UpsertLevelInput {
  productId: string;
  warehouseId: string;
  quantity: Quantity;
  avgCostMinor: bigint;
  currencyCode: string;
}

export interface ListMovementsFilter {
  productId?: string;
  warehouseId?: string;
  limit?: number;
}

export interface ListLevelsFilter {
  warehouseId?: string;
  productIds?: string[];
}

export interface ProductWarehousePair {
  productId: string;
  warehouseId: string;
}

export interface StockRepository {
  // Locks the matching stock_levels rows FOR UPDATE, ordered by productId
  // -- required by confirmSale (step 3 of this plan) to avoid a deadlock
  // between two tills selling the same products in a different order.
  // Exposed on this port because inventory owns `stock_levels`; sales will
  // reach it only through `applyStockOut(ctx, ...)` below, never by
  // querying `stock_levels` directly (forbidden by the cross-module ESLint
  // boundary rule -- sales may not import @/db/schema/inventory).
  lockLevelsForUpdate(
    ctx: TenantSessionContext,
    warehouseId: string,
    productIds: string[]
  ): Promise<StockLevelRecord[]>;

  getLevel(
    ctx: TenantSessionContext,
    productId: string,
    warehouseId: string
  ): Promise<StockLevelRecord | null>;

  listLevels(ctx: TenantSessionContext, filter: ListLevelsFilter): Promise<StockLevelRecord[]>;

  upsertLevel(ctx: TenantSessionContext, input: UpsertLevelInput): Promise<void>;

  insertMovement(
    ctx: TenantSessionContext,
    input: InsertMovementInput
  ): Promise<StockMovementRecord>;

  listMovements(
    ctx: TenantSessionContext,
    filter: ListMovementsFilter
  ): Promise<StockMovementRecord[]>;

  // H3 fix (security-reviewer, High) support: `rebuildStockLevels` needs
  // every (product, warehouse) pair that has EVER had a movement, and the
  // FULL, unlimited, chronologically-ordered ledger for each -- unlike
  // `listMovements` (capped at 100, most-recent-first, for display).
  listDistinctProductWarehousePairs(ctx: TenantSessionContext): Promise<ProductWarehousePair[]>;

  listAllMovementsForRebuild(
    ctx: TenantSessionContext,
    productId: string,
    warehouseId: string
  ): Promise<StockMovementRecord[]>;
}
