import type { MoneyMinorDto } from "@/platform/dto/money";

export type PaymentMethod = "cash" | "mobile_money" | "bank_transfer" | "card" | "other";

export interface ConfirmSaleLineInput {
  productId: string;
  quantity: string; // numeric(18,4) string -- never a number
  discountMinor?: MoneyMinorDto; // default "0"
}

export interface ConfirmSalePaymentInput {
  method: PaymentMethod;
  // Exactly one of these -- `full: true` tells the SERVER to compute
  // paidMinor = totals.totalMinor itself (H2 fix: the client must never
  // decide the amount for "pay in full". The POS only knows the HT
  // subtotal before VAT is applied server-side; sending a client-computed
  // "total" as amountMinor silently falls short of the real TTC total the
  // moment vat_rate > 0, misrouting a full cash sale into the credit
  // branch and refusing it for lack of a customer).
  amountMinor?: MoneyMinorDto;
  full?: boolean;
  reference?: string | null;
}

export interface ConfirmSaleInput {
  // Generated ONCE on the client at the moment the cashier confirms, and
  // NEVER regenerated on retry -- see docs/platform.md / CLAUDE.md D1. This
  // use case only validates shape; it never invents a fallback key.
  idempotencyKey: string;
  warehouseId: string;
  customerId?: string | null;
  currencyCode: string;
  lines: ConfirmSaleLineInput[];
  // Absent/undefined = a pure credit sale (zero collected at confirmation).
  payment?: ConfirmSalePaymentInput | null;
  // Only ever honored if the actor also holds `stock:oversell` -- see
  // confirm-sale.ts's header comment.
  allowOversell?: boolean;
}

export interface ConfirmSaleLineResult {
  productId: string;
  quantity: string;
  unitPriceMinor: MoneyMinorDto;
  discountMinor: MoneyMinorDto;
  vatRate: string;
  unitCostMinor: MoneyMinorDto;
  lineTotalMinor: MoneyMinorDto;
  lineNo: number;
}

// ---------------------------------------------------------------------------
// Sales history (listSales) + document (ticket/invoice) screens.
// ---------------------------------------------------------------------------

export interface SaleSummaryDto {
  id: string;
  warehouseId: string;
  customerId: string | null;
  status: "draft" | "confirmed" | "cancelled";
  paymentStatus: "unpaid" | "partial" | "paid";
  currencyCode: string;
  totalMinor: MoneyMinorDto;
  paidMinor: MoneyMinorDto;
  ticketNumber: string | null;
  fiscalYear: number | null;
  createdBy: string;
  confirmedAt: string | null; // ISO 8601
}

export interface ListSalesInput {
  warehouseId?: string;
  customerId?: string;
  paymentStatus?: "unpaid" | "partial" | "paid";
  ticketNumber?: string; // bigint DTO -- see platform/dto/money's string convention
  periodFrom?: string; // ISO date
  periodTo?: string; // ISO date
}

export interface SaleDetailDto extends SaleSummaryDto {
  subtotalMinor: MoneyMinorDto;
  vatMinor: MoneyMinorDto;
  discountMinor: MoneyMinorDto;
  lines: ConfirmSaleLineResult[];
}

export interface ConfirmSaleResult {
  saleId: string;
  ticketNumber: string; // bigint -> string (DTO boundary)
  fiscalYear: number;
  currencyCode: string;
  subtotalMinor: MoneyMinorDto;
  discountMinor: MoneyMinorDto;
  vatMinor: MoneyMinorDto;
  totalMinor: MoneyMinorDto;
  paidMinor: MoneyMinorDto;
  paymentStatus: "unpaid" | "partial" | "paid";
  lines: ConfirmSaleLineResult[];
  // True when this call returned an EXISTING confirmed sale (idempotency
  // replay) instead of confirming a new one. H1 fix: the POS UI MUST
  // surface this ("vente déjà enregistrée, ticket n° X") -- it is no
  // longer purely a telemetry marker, since a replay now carries real
  // information the cashier needs (this wasn't a fresh sale).
  replayed: boolean;
}
