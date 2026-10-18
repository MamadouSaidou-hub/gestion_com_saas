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

export interface AnalyticsRepository {
  // CA brut: confirmed_at in window, ANY current status (a sale later
  // cancelled still counts toward brut). CA net: same window, status =
  // 'confirmed' only.
  getSalesWindowTotals(ctx: TenantSessionContext, window: WindowArgs): Promise<SalesWindowTotals>;

  // Encaissé: payments.received_at in window, voided_at IS NULL --
  // independent of which window the underlying sale belongs to.
  getEncaisse(ctx: TenantSessionContext, window: EncaisseWindowArgs): Promise<bigint>;

  getEncaisseByMethod(ctx: TenantSessionContext, window: EncaisseWindowArgs): Promise<MethodAmount[]>;

  // All products with at least one confirmed sale_line in the window,
  // unsorted/unlimited -- the application layer picks top-5-by-revenue and
  // top-5-by-quantity from the SAME result set (small data volume at this
  // scale; avoids two different queries with different ORDER BY/LIMIT).
  getTopProductsRaw(ctx: TenantSessionContext, window: WindowArgs): Promise<TopProductRow[]>;

  getMarginTotals(ctx: TenantSessionContext, window: WindowArgs): Promise<MarginTotals>;

  getSellerBreakdown(ctx: TenantSessionContext, window: WindowArgs): Promise<SellerRow[]>;

  getOwnSalesSummary(
    ctx: TenantSessionContext,
    userId: string,
    window: WindowArgs
  ): Promise<OwnSalesSummary>;

  // Low-stock alerts need the structure's default warehouse id --
  // resolved here (read-only) rather than hardcoding "single warehouse in
  // v1" into the use case.
  getDefaultWarehouseId(ctx: TenantSessionContext): Promise<string | null>;
}
