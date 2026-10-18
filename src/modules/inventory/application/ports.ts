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
  // Multi-store transfers / physical counts (migration 0014's exclusive-arc
  // columns, closed in full by that migration -- see db/README entry 2r).
  // Mutually exclusive with saleId/sourceType at the DB level
  // (num_nonnulls(...) = 1); the repository is responsible for only ever
  // setting exactly one of these per insertMovement call.
  transferId: string | null;
  stockCountId: string | null;
  // Purchasing module (migration 0015's composite-FK column, activated by
  // that migration -- 0014 added the column ahead of time, see db/README
  // entry 2r/2y). Mutually exclusive with every other arc at the DB level
  // (stock_movements_exclusive_arc_chk).
  supplierDeliveryId: string | null;
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
  // Transfers module/physical-counts module pass EXACTLY one of these (and
  // never together with saleId) -- see stock_movements_exclusive_arc_chk.
  transferId?: string | null;
  stockCountId?: string | null;
  // Purchasing module's own arc -- see StockMovementRecord.supplierDeliveryId.
  supplierDeliveryId?: string | null;
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
  // Locks the matching stock_levels rows FOR UPDATE, ordered by (warehouse
  // id is constant here, then) productId -- required by confirmSale (step
  // 3 of this plan) to avoid a deadlock between two tills selling the same
  // products in a different order. Single-warehouse by construction: every
  // CURRENT caller (applyStockOut) only ever locks rows within ONE store in
  // a given call. Exposed on this port because inventory owns
  // `stock_levels`; sales will reach it only through `applyStockOut(ctx,
  // ...)` below, never by querying `stock_levels` directly (forbidden by
  // the cross-module ESLint boundary rule -- sales may not import
  // @/db/schema/inventory).
  lockLevelsForUpdate(
    ctx: TenantSessionContext,
    warehouseId: string,
    productIds: string[]
  ): Promise<StockLevelRecord[]>;

  // Multi-store (migration 0014) deadlock-avoidance primitive -- db/README
  // entry 2x: with two stores active, an operation that locks
  // `stock_levels` rows in MORE THAN ONE warehouse within the SAME
  // transaction (e.g. a future stock-transfer confirmation applying both
  // the outgoing leg at the source store and the incoming leg at the
  // destination store) must lock EVERY row it needs in ONE statement,
  // ordered deterministically by `(warehouse_id, product_id)` -- never by
  // two separate `lockLevelsForUpdate` calls in caller-chosen order, which
  // is exactly what lets crossed transfers (A->B and B->A, confirmed
  // concurrently) deadlock against each other. No caller in THIS codebase
  // uses this yet (no transfer-confirmation use case is built in this
  // phase) -- it exists so the implementer of that use case has the
  // correct primitive ready, instead of reproducing the single-warehouse
  // `lockLevelsForUpdate` pattern and re-introducing the deadlock.
  lockLevelsForUpdateAcrossWarehouses(
    ctx: TenantSessionContext,
    pairs: ProductWarehousePair[]
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
  // multi-store: optional `warehouseId` restricts the rebuild to one
  // store's pairs; `null`/omitted (unchanged default) returns every pair
  // in the tenant across every store.
  listDistinctProductWarehousePairs(
    ctx: TenantSessionContext,
    warehouseId?: string | null
  ): Promise<ProductWarehousePair[]>;

  listAllMovementsForRebuild(
    ctx: TenantSessionContext,
    productId: string,
    warehouseId: string
  ): Promise<StockMovementRecord[]>;
}
