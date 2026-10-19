import type { TenantSessionContext } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// AnalyticsRepository -- the single port behind which every DIRECT
// INDEXED QUERY lives (per the coordinator's explicit instruction: no
// materialized view, no rollup table -- freshness over micro-latency at
// this data volume). If volume ever justifies a rollup table, that is a
// SECOND adapter implementing this SAME port -- zero page/service changes.
// See docs/platform.md for the revisit trigger (p95 > 300ms or
// ~500k sale_lines).
// ---------------------------------------------------------------------------

export interface WindowArgs {
  start: Date;
  end: Date;
}

// H5 fix (security-reviewer): `end` is OPTIONAL here specifically for the
// encaissé queries. `payments.received_at` and the window's upper bound
// used to come from two different clocks (Postgres DEFAULT now() vs
// Node's `new Date()`); a few hundred ms of drift could put a
// just-recorded payment "in the future" relative to the window, dropping
// it from "today" until the app clock caught up. Two independent fixes:
// (1) `received_at` is now set explicitly from the app clock at insert
// (see InsertSalePaymentInput.receivedAt), and (2) the CURRENT period's
// upper bound is dropped entirely here -- "a payment in the future
// doesn't exist", so there is nothing to protect against by capping it at
// `now()` computed by a possibly-slightly-different clock than the one
// that stamped the payment. The PREVIOUS period still needs a real upper
// bound (that boundary is a fixed point in the past, not "now").
export interface EncaisseWindowArgs {
  start: Date;
  end?: Date;
}

export interface SalesWindowTotals {
  grossMinor: bigint;
  grossCount: number;
  netMinor: bigint;
  netCount: number;
}

export interface MethodAmount {
  method: string;
  amountMinor: bigint;
}

export interface TopProductRow {
  productId: string;
  sku: string;
  name: string;
  revenueMinor: bigint;
  quantity: string; // numeric(18,4) string -- never a number
}

export interface MarginTotals {
  // NET-of-VAT (HT) revenue -- collected VAT is remitted to the state, not
  // revenue; comparing COGS against TTC would overstate margin for a
  // VAT-registered shop. Identical to TTC when vat_rate = 0.
  revenueMinor: bigint;
  costMinor: bigint;
}

export interface SellerRow {
  sellerId: string;
  saleCount: number;
  totalMinor: bigint;
}

export interface OwnSalesSummary {
  saleCount: number;
  totalMinor: bigint;
}

export interface LowStockRow {
  productId: string;
  sku: string;
  name: string;
  quantity: string;
  lowStockThreshold: string;
}

// multi-store (migration 0014): every query below now takes a REQUIRED
// `storeScope: string | null` -- `null` means "every store the actor can
// see" (an owner's unscoped dashboard, unchanged from before this
// migration), a warehouse id restricts the aggregate to exactly that
// store (a gerant's own store, floored by RLS too since `sales`/`payments`
// both carry the store-scope predicate since 0014; or an owner's explicit
// selector choice). Making it required (not optional) is the same
// discipline as every other `scope`/`storeScope` parameter in this
// codebase -- omitting it is a compile error, not a silent "all stores"
// leak into a gerant's own dashboard.
export interface AnalyticsRepository {
  // CA brut: confirmed_at in window, ANY current status (a sale later
  // cancelled still counts toward brut). CA net: same window, status =
  // 'confirmed' only.
  getSalesWindowTotals(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<SalesWindowTotals>;

  // Encaissé: payments.received_at in window, voided_at IS NULL --
  // independent of which window the underlying sale belongs to.
  getEncaisse(
    ctx: TenantSessionContext,
    window: EncaisseWindowArgs,
    storeScope: string | null
  ): Promise<bigint>;

  getEncaisseByMethod(
    ctx: TenantSessionContext,
    window: EncaisseWindowArgs,
    storeScope: string | null
  ): Promise<MethodAmount[]>;

  // All products with at least one confirmed sale_line in the window,
  // unsorted/unlimited -- the application layer picks top-5-by-revenue and
  // top-5-by-quantity from the SAME result set (small data volume at this
  // scale; avoids two different queries with different ORDER BY/LIMIT).
  getTopProductsRaw(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<TopProductRow[]>;

  getMarginTotals(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<MarginTotals>;

  getSellerBreakdown(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<SellerRow[]>;

  getOwnSalesSummary(
    ctx: TenantSessionContext,
    userId: string,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<OwnSalesSummary>;

  // --- Trésorerie (treasury) ---
  //
  // "Cash sale" vs "receivable collected" is NOT a stored flag -- both
  // kinds of customer payment land in the SAME `payments` row shape
  // (confirmSale's at-sale-time payment and the standalone recordPayment
  // use case share the table). The distinguishing signal is the one
  // structural fact that is always true: a payment collected AT
  // confirmation time is inserted with `received_at` set to the EXACT
  // SAME app-clock value as the sale's own `confirmed_at` (see
  // confirm-sale.ts, `receivedAt: confirmedAt`); any payment recorded
  // LATER (recordPayment, paying down a receivable) is necessarily
  // stamped strictly after that moment. This is a documented judgment
  // call, not a schema guarantee -- flag for security-reviewer if a
  // future payment path ever stamps `received_at` some other way.
  getCashSalesTotal(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<bigint>;

  getReceivableCollectionsTotal(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<bigint>;

  // Tenant-level only (never store-scoped, D-aligned with purchasing's
  // supplier-debt consolidation decision, db/README entry 2y) -- the
  // caller (getTreasury) must only issue this for an UNSCOPED actor.
  getSupplierPaymentsTotal(ctx: TenantSessionContext, window: WindowArgs): Promise<bigint>;

  // Revenue broken down by store for the period -- "Rapports" screen.
  // `storeScope` narrows to one store (gerant, or an owner's explicit
  // selection); `null` returns one row per store in the tenant.
  getRevenueByStore(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<Array<{ warehouseId: string; netMinor: bigint; netCount: number }>>;
}
