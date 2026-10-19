import type { MoneyMinorDto } from "@/platform/dto/money";
import type { PeriodGranularity } from "../domain/period";

export interface TopProductDto {
  productId: string;
  sku: string;
  name: string;
  revenueMinor: MoneyMinorDto;
  quantity: string; // numeric(18,4) string -- never a number
}

export interface SellerBreakdownDto {
  sellerId: string;
  saleCount: number;
  totalMinor: MoneyMinorDto;
}

export interface LowStockAlertDto {
  productId: string;
  sku: string;
  name: string;
  // multi-store: which store this alert is for -- surfaced explicitly now
  // that a dashboard with no store filter aggregates across every store
  // (one alert per product x store, never summed).
  warehouseId: string;
  quantity: string;
  lowStockThreshold: string;
}

export interface MarginDto {
  revenueMinor: MoneyMinorDto;
  costMinor: MoneyMinorDto;
  marginMinor: MoneyMinorDto;
  marginPct: number | null;
}

export interface ReceivablesDto {
  totalOutstandingMinor: MoneyMinorDto;
  overdueMinor: MoneyMinorDto;
}

// Financial fields -- ONLY present for an actor with `dashboard:read_financials`.
// Never computed (let alone fetched) for an actor without it -- see
// get-dashboard.ts's header comment.
export interface DashboardFinancialsDto {
  caBrutMinor: MoneyMinorDto; // TTC, confirmed_at in window, any current status
  caNetMinor: MoneyMinorDto; // same window, status = 'confirmed' only (minus cancellations)
  // Present only when tax_settings.vat_rate > 0 (D4 -- many shops aren't
  // VAT-registered; omit the HT/TTC split entirely rather than show a
  // meaningless "0" VAT line).
  vatMinor: MoneyMinorDto | null;
  encaisseMinor: MoneyMinorDto; // payments.received_at in window -- independent of the sale's own window
  encaisseByMethod: Array<{ method: string; amountMinor: MoneyMinorDto }>;
  receivables: ReceivablesDto; // point-in-time, no date filter
  saleCount: number;
  averageBasketMinor: MoneyMinorDto;
  topProductsByRevenue: TopProductDto[];
  topProductsByQuantity: TopProductDto[];
  margin: MarginDto;
  sellerBreakdown: SellerBreakdownDto[];
  comparisonToPreviousPeriod: {
    caBrutMinor: MoneyMinorDto;
    caNetMinor: MoneyMinorDto;
    encaisseMinor: MoneyMinorDto;
  };
}

export interface DashboardDto {
  period: PeriodGranularity;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  // Always present, scoped to the actor's OWN sales -- never "global" for
  // a cashier.
  ownSaleCount: number;
  ownTotalMinor: MoneyMinorDto;
  lowStockAlerts: LowStockAlertDto[];
  // `undefined` (key absent after JSON serialization) for an actor without
  // `dashboard:read_financials` -- not an empty object, not zeroed-out
  // fields. The absence itself is the signal.
  financials?: DashboardFinancialsDto;
}

export interface GetDashboardInput {
  period: PeriodGranularity;
  referenceDate?: Date;
  // multi-store: OPTIONAL store selector value from the UI -- only ever
  // rendered/sent from the SECOND store onward (per the "single-store shop
  // must not get more complex" product rule) and from an UNSCOPED actor
  // (a store-scoped gerant's own store always wins regardless, see
  // `resolveStoreScope`).
  warehouseId?: string | null;
}

// ---------------------------------------------------------------------------
// Trésorerie (treasury) -- consolidated money view. `supplier` is `null`,
// not a zeroed-out object, for a store-scoped actor (gerant) -- the
// supplier side is consolidated at tenant level by product decision and is
// simply never fetched for them (see get-treasury.ts). The key itself is
// still always present so the DTO shape is stable for the client either
// way; its VALUE being null is the signal, same convention as
// `DashboardDto.financials` being entirely absent for a cashier.
// ---------------------------------------------------------------------------
export interface TreasurySupplierDto {
  paymentsMadeMinor: MoneyMinorDto;
  debtOwedMinor: MoneyMinorDto;
}

export interface TreasuryDto {
  period: PeriodGranularity;
  windowStart: string;
  windowEnd: string;
  cashSalesMinor: MoneyMinorDto;
  receivableCollectionsMinor: MoneyMinorDto;
  totalEncaisseMinor: MoneyMinorDto;
  receivablesOwedToUsMinor: MoneyMinorDto;
  supplier: TreasurySupplierDto | null;
}

export interface GetTreasuryInput {
  period: PeriodGranularity;
  referenceDate?: Date;
  warehouseId?: string | null;
}

// ---------------------------------------------------------------------------
// Rapports (reports) -- revenue by store, top products, by period. Same
// direct-indexed-query discipline as the dashboard (no materialized view).
// ---------------------------------------------------------------------------
export interface RevenueByStoreDto {
  warehouseId: string;
  netMinor: MoneyMinorDto;
  saleCount: number;
}

export interface ReportsDto {
  period: PeriodGranularity;
  windowStart: string;
  windowEnd: string;
  revenueByStore: RevenueByStoreDto[];
  topProductsByRevenue: TopProductDto[];
  topProductsByQuantity: TopProductDto[];
}

export interface GetReportsInput {
  period: PeriodGranularity;
  referenceDate?: Date;
  warehouseId?: string | null;
}
