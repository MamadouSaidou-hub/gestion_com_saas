import type { TenantSessionContext } from "@/platform/db/withTenantSession";

export type SaleStatus = "draft" | "confirmed" | "cancelled";
export type SalePaymentStatus = "unpaid" | "partial" | "paid";

export interface SaleHeaderRecord {
  id: string;
  structureId: string;
  customerId: string | null;
  warehouseId: string;
  status: SaleStatus;
  currencyCode: string;
  totalMinor: bigint;
  subtotalMinor: bigint;
  vatMinor: bigint;
  discountMinor: bigint;
  paidMinor: bigint;
  fiscalYear: number | null;
  ticketNumber: bigint | null;
  paymentStatus: SalePaymentStatus;
  idempotencyKey: string;
  requestFingerprint: string;
  createdBy: string;
  confirmedAt: Date | null;
}

export interface SaleLineRecord {
  id: string;
  saleId: string;
  productId: string;
  quantity: string;
  unitPriceMinor: bigint;
  currencyCode: string;
  lineTotalMinor: bigint;
  vatRate: string;
  discountMinor: bigint;
  unitCostMinor: bigint;
  lineNo: number;
}

export interface InsertDraftSaleInput {
  customerId: string | null;
  warehouseId: string;
  currencyCode: string;
  idempotencyKey: string;
  requestFingerprint: string;
  createdBy: string;
}

export interface ConfirmSaleHeaderPatch {
  ticketNumber: bigint;
  fiscalYear: number;
  subtotalMinor: bigint;
  vatMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
  paidMinor: bigint;
  paymentStatus: SalePaymentStatus;
  confirmedAt: Date;
}

export interface InsertSaleLineInput {
  productId: string;
  quantity: string;
  unitPriceMinor: bigint;
  currencyCode: string;
  lineTotalMinor: bigint;
  vatRate: string;
  discountMinor: bigint;
  unitCostMinor: bigint;
  lineNo: number;
}

export interface PaymentProgressDelta {
  // Signed delta applied ATOMICALLY in SQL (paid_minor = paid_minor +
  // delta, bounds-checked in the same statement) -- never a JS
  // read-modify-write (C1 security-reviewer finding: a plain
  // findById-then-absolute-write loses one of two concurrent payments).
  deltaMinor: bigint;
}

// ---------------------------------------------------------------------------
// listSales (sales history screen) -- a filtered, scoped read. Honours BOTH
// scoping axes independently: `createdBy` ('own' scope for a cashier
// without `sale:read_all`) AND `storeScope` (a gerant's single store) --
// both are plain AND-ed SQL predicates, never post-filtered in application
// memory, so the CSV export (which re-runs this exact query) stays correct
// and fast at any row count.
// ---------------------------------------------------------------------------
export interface ListSalesFilter {
  // 'own' scope -- set by the use case from scopeFor(actor, 'sale:read'),
  // never client-supplied.
  createdBy?: string;
  // multi-store -- REQUIRED by the use case to resolve (null = every store
  // the actor may see).
  storeScope: string | null;
  warehouseId?: string; // optional additional narrowing (store picker on an unscoped actor)
  customerId?: string;
  status?: SaleStatus;
  paymentStatus?: SalePaymentStatus;
  ticketNumber?: bigint;
  // Inclusive date range over `confirmed_at` (the accounting day, UTC --
  // see analytics/domain/period.ts's convention, reused here for consistency).
  periodFrom?: Date;
  periodTo?: Date;
  limit?: number;
}

export interface SalesRepository {
  // `ON CONFLICT (structure_id, idempotency_key) DO NOTHING RETURNING id` --
  // returns null on conflict (replay), NEVER pre-SELECTs to check existence
  // first (that would be a race, per the architect's explicit instruction).
  tryInsertDraft(
    ctx: TenantSessionContext,
    input: InsertDraftSaleInput
  ): Promise<SaleHeaderRecord | null>;

  findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<SaleHeaderRecord | null>;

  findById(ctx: TenantSessionContext, saleId: string): Promise<SaleHeaderRecord | null>;

  // L-b fix (security-reviewer follow-up): batched -- one query for a
  // whole list of sale ids, instead of billing's getCreatedByForSales
  // doing an N+1 (`findById` per sale) to resolve the 'own' scope filter
  // for listInvoices/listPayments. Returns only the (saleId -> createdBy)
  // pairs that exist; a caller-supplied id with no matching row is simply
  // absent from the result.
  findCreatedByForSaleIds(
    ctx: TenantSessionContext,
    saleIds: string[]
  ): Promise<Record<string, string>>;

  // L-b fix (security-reviewer follow-up) support -- see
  // list-sale-ids-created-by.ts.
  listSaleIdsCreatedBy(ctx: TenantSessionContext, userId: string): Promise<string[]>;

  // All CONFIRMED sales not yet fully paid ('unpaid' or 'partial') --
  // point-in-time, no date filter. Used by billing's getReceivables.
  listOpen(ctx: TenantSessionContext): Promise<SaleHeaderRecord[]>;

  // Sales history screen + its CSV export -- see ListSalesFilter's header
  // comment. Only ever returns CONFIRMED or CANCELLED sales (a draft row is
  // either mid-transaction on another connection or an abandoned replay
  // target -- never something a user should see in a history list); callers
  // that want every status may still pass `status` explicitly.
  list(ctx: TenantSessionContext, filter: ListSalesFilter): Promise<SaleHeaderRecord[]>;

  // Every DISTINCT customerId that has at least one sale in the given
  // store -- used to scope the clients screen for a gerant ("customers who
  // have activity in their store", per the approved product decision).
  // `null` customerId (anonymous sales) is never included.
  listCustomerIdsForStore(ctx: TenantSessionContext, warehouseId: string): Promise<string[]>;

  // Every DISTINCT warehouseId a given set of sale ids was confirmed
  // against -- used by billing's getReceivablesByCustomer to store-scope
  // invoices (which have no warehouse_id column of their own) via their
  // linked sale.
  findWarehouseIdsForSaleIds(
    ctx: TenantSessionContext,
    saleIds: string[]
  ): Promise<Record<string, string>>;

  listLines(ctx: TenantSessionContext, saleId: string): Promise<SaleLineRecord[]>;

  insertLines(
    ctx: TenantSessionContext,
    saleId: string,
    lines: InsertSaleLineInput[]
  ): Promise<SaleLineRecord[]>;

  confirmHeader(
    ctx: TenantSessionContext,
    saleId: string,
    patch: ConfirmSaleHeaderPatch
  ): Promise<SaleHeaderRecord>;

  // Used by billing's recordPayment/voidPayment (via
  // salesService.recordPaymentProgress) -- a ctx-based primitive, no
  // transaction of its own, same convention as inventory's applyStockOut.
  //
  // ATOMIC: the increment and the bounds check (0 <= new paid_minor <=
  // total_minor) happen in the SAME SQL statement against the CURRENT row
  // value, not a value read earlier in JS -- this is what makes two
  // concurrent calls for the same sale both land instead of one clobbering
  // the other (C1). Returns null (not a thrown error) when the bounds
  // check fails or the row doesn't exist -- the caller decides which.
  updatePaymentProgress(
    ctx: TenantSessionContext,
    saleId: string,
    delta: PaymentProgressDelta
  ): Promise<SaleHeaderRecord | null>;
}
