import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { Quantity } from "@/modules/inventory";

// Domain-shaped records (bigint money, Quantity value object) -- what the
// application layer and repository implementations exchange. Mapped to
// transport DTOs only at a use case's return boundary (see mappers.ts).

export type TransferStatus = "in_transit" | "received" | "cancelled";

export interface TransferHeaderRecord {
  id: string;
  structureId: string;
  reference: string;
  fiscalYear: number;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: TransferStatus;
  currencyCode: string;
  createdBy: string;
  createdAt: Date;
  receivedBy: string | null;
  receivedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
}

export interface TransferLineRecord {
  id: string;
  transferId: string;
  productId: string;
  quantity: Quantity;
  unitCostMinor: bigint;
  lineNo: number;
}

export interface InsertDraftTransferInput {
  fromWarehouseId: string;
  toWarehouseId: string;
  currencyCode: string;
  reference: string;
  fiscalYear: number;
  idempotencyKey: string;
  requestFingerprint: string;
  createdBy: string;
}

export interface InsertTransferLineInput {
  productId: string;
  quantity: Quantity;
  unitCostMinor: bigint;
  lineNo: number;
}

export interface ListTransfersFilter {
  // `null` = every store the actor can see (owner/unscoped); a real
  // warehouse id restricts to transfers where that store is EITHER the
  // origin OR the destination (mirrors the RLS predicate, migration 0014).
  storeScope: string | null;
  status?: TransferStatus;
  limit?: number;
}

export interface TransfersRepository {
  tryInsertDraft(
    ctx: TenantSessionContext,
    input: InsertDraftTransferInput
  ): Promise<TransferHeaderRecord | null>;

  findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<TransferHeaderRecord | null>;

  findById(ctx: TenantSessionContext, transferId: string): Promise<TransferHeaderRecord | null>;

  insertLines(
    ctx: TenantSessionContext,
    transferId: string,
    lines: InsertTransferLineInput[]
  ): Promise<TransferLineRecord[]>;

  // Overwrites the placeholder reference/fiscalYear/currencyCode the draft
  // row was inserted with (see create-transfer.ts's header comment: the
  // idempotency key must be claimed BEFORE the gapless reference is
  // allocated, same ordering lesson as confirmSale's ticket number, but
  // stock_transfers has no separate "draft" status to insert into first --
  // this UPDATE, still inside the SAME uncommitted transaction, plays that
  // role instead). Never visible to another transaction with the
  // placeholder values, since nothing commits until this has already run.
  finalizeHeader(
    ctx: TenantSessionContext,
    transferId: string,
    patch: { reference: string; fiscalYear: number; currencyCode: string }
  ): Promise<TransferHeaderRecord>;

  listLines(ctx: TenantSessionContext, transferId: string): Promise<TransferLineRecord[]>;

  list(ctx: TenantSessionContext, filter: ListTransfersFilter): Promise<TransferHeaderRecord[]>;

  // UPDATE-as-arbiter (`WHERE status = 'in_transit' RETURNING *`) -- the
  // SAME lesson as billing's markVoided: rowCount 0 means "not in transit
  // anymore" (already received/cancelled), never a separate read-then-write
  // race. Returns null on that guard failing.
  markReceived(
    ctx: TenantSessionContext,
    transferId: string,
    receivedBy: string,
    receivedAt: Date
  ): Promise<TransferHeaderRecord | null>;

  markCancelled(
    ctx: TenantSessionContext,
    transferId: string,
    cancelledBy: string,
    cancelledAt: Date,
    cancelReason: string | null
  ): Promise<TransferHeaderRecord | null>;

  // The in-transit derived figure (db/README's invariant: Σ stock_levels +
  // in_transit = quantity held) -- sums EVERY in_transit transfer line's
  // quantity, grouped by productId, restricted to transfers where
  // `storeScope` is either leg (or unrestricted when storeScope is null).
  // Each line counted exactly ONCE regardless of direction -- never
  // double-counted for being both a store's outgoing AND another
  // transfer's incoming leg.
  sumInTransitQuantityByProduct(
    ctx: TenantSessionContext,
    storeScope: string | null
  ): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Physical stock counts.
// ---------------------------------------------------------------------------

export type StockCountStatus = "draft" | "validated" | "cancelled";

export interface StockCountHeaderRecord {
  id: string;
  structureId: string;
  warehouseId: string;
  status: StockCountStatus;
  createdBy: string;
  createdAt: Date;
  validatedBy: string | null;
  validatedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  idempotencyKey: string;
}

export interface StockCountLineRecord {
  id: string;
  stockCountId: string;
  productId: string;
  theoreticalQty: Quantity;
  countedQty: Quantity | null;
  varianceQty: Quantity | null;
  unitCostMinor: bigint;
  varianceValueMinor: bigint | null;
}

export interface InsertDraftStockCountInput {
  warehouseId: string;
  idempotencyKey: string;
  createdBy: string;
}

export interface InsertStockCountLineInput {
  productId: string;
  theoreticalQty: Quantity;
}

export interface StockCountLineResultPatch {
  productId: string;
  countedQty: Quantity;
  varianceQty: Quantity;
  unitCostMinor: bigint;
  varianceValueMinor: bigint;
}

export interface ListStockCountsFilter {
  storeScope: string | null;
  status?: StockCountStatus;
  limit?: number;
}

export interface ListVarianceLinesFilter {
  storeScope: string | null;
  limit?: number;
}

// A joined, display-ready row for the "Écarts récents" screen -- spans
// stock_count_lines (floor-only RLS) joined to its already store-scoped
// parent header, so this is the one place in this module that needs both
// repositories' knowledge at once (implemented by whichever repository
// owns the join; exposed as its own port method rather than forcing the
// application layer to stitch two separate queries together).
export interface VarianceLineRow {
  stockCountId: string;
  warehouseId: string;
  productId: string;
  theoreticalQty: Quantity;
  countedQty: Quantity;
  varianceQty: Quantity;
  unitCostMinor: bigint;
  varianceValueMinor: bigint;
  validatedAt: Date;
}

export interface StockCountsRepository {
  tryInsertDraft(
    ctx: TenantSessionContext,
    input: InsertDraftStockCountInput
  ): Promise<StockCountHeaderRecord | null>;

  findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<StockCountHeaderRecord | null>;

  findById(ctx: TenantSessionContext, stockCountId: string): Promise<StockCountHeaderRecord | null>;

  insertLines(
    ctx: TenantSessionContext,
    stockCountId: string,
    lines: InsertStockCountLineInput[]
  ): Promise<StockCountLineRecord[]>;

  listLines(ctx: TenantSessionContext, stockCountId: string): Promise<StockCountLineRecord[]>;

  list(ctx: TenantSessionContext, filter: ListStockCountsFilter): Promise<StockCountHeaderRecord[]>;

  // UPDATE-as-arbiter, same pattern as TransfersRepository.markReceived.
  markValidated(
    ctx: TenantSessionContext,
    stockCountId: string,
    validatedBy: string,
    validatedAt: Date
  ): Promise<StockCountHeaderRecord | null>;

  // No `markCancelled` for stock counts -- out of this phase's scope (the
  // task's spec covers open/validate only; `stock_counts.status` still has
  // a `cancelled` enum value the schema is ready for, simply unexercised
  // by the app layer today).

  // Batched write of the counted/variance results onto each line, at
  // validation time -- one statement per line (small batches: a physical
  // count is bounded by what a human can realistically count in one pass).
  patchLineResults(
    ctx: TenantSessionContext,
    stockCountId: string,
    patches: StockCountLineResultPatch[]
  ): Promise<void>;

  listVarianceLines(ctx: TenantSessionContext, filter: ListVarianceLinesFilter): Promise<VarianceLineRow[]>;
}
