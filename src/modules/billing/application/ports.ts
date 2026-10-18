import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { InvoiceStatus } from "./dto";

// ---------------------------------------------------------------------------
// Billing ports. Two generations in this file, kept together since they
// share a module:
//  - The narrow, ctx-based primitives `confirmSale` needs (tax rate,
//    ticket-number allocation, payment insert) -- built in Phase 1 step 3.
//  - The full standalone use cases (recordPayment, issueInvoiceForSale,
//    voidPayment, read side) -- built in step 4.
// ---------------------------------------------------------------------------

export interface TaxSettingsRepository {
  getVatRate(ctx: TenantSessionContext): Promise<string>;
  getInvoicePrefix(ctx: TenantSessionContext): Promise<string | null>;
}

export interface DocumentCounterRepository {
  allocateNext(
    ctx: TenantSessionContext,
    docType: "ticket" | "invoice" | "quote" | "credit_note" | "delivery_note",
    fiscalYear: number
  ): Promise<bigint>;
}

export interface InsertSalePaymentInput {
  saleId: string;
  customerId: string | null;
  amountMinor: bigint;
  currencyCode: string;
  method: string;
  idempotencyKey: string;
  reference?: string | null;
  // H5 fix (security-reviewer): set explicitly by the caller (confirmSale
  // passes the SAME `Date` it used for `confirmed_at`) rather than left to
  // the column's `DEFAULT now()` -- two different clocks (Postgres vs
  // Node) drifting by even a few hundred ms was enough to put a
  // just-recorded payment outside "today" in the dashboard's encaissé
  // query until the app clock caught up.
  receivedAt: Date;
}

export interface PaymentRecord {
  id: string;
  amountMinor: bigint;
}

export interface PaymentFullRecord {
  id: string;
  saleId: string | null;
  customerId: string | null;
  amountMinor: bigint;
  currencyCode: string;
  method: string;
  receivedAt: Date;
  reference: string | null;
  voidedAt: Date | null;
  createdBy: string;
}

export interface InsertStandalonePaymentInput {
  saleId: string | null;
  customerId: string | null;
  amountMinor: bigint;
  currencyCode: string;
  method: string;
  idempotencyKey: string;
  reference?: string | null;
  createdBy: string;
  // H5 fix -- see InsertSalePaymentInput.receivedAt.
  receivedAt: Date;
}

export interface AllocationInput {
  paymentId: string;
  invoiceId: string;
  amountMinor: bigint;
  currencyCode: string;
}

export interface AllocationRecord {
  invoiceId: string;
  amountMinor: bigint;
}

export interface ListPaymentsFilter {
  createdBy?: string;
  // L-b fix (security-reviewer follow-up): lets listPayments push the
  // 'own' scope filter into SQL (`sale_id IN (...)`) instead of fetching
  // every tenant row and filtering in application memory.
  saleIds?: string[];
}

export interface PaymentRepository {
  // Used by confirmSale (via billingService.recordSalePayment) -- plain
  // insert, no idempotency re-check needed at THIS level (confirmSale's
  // own idempotency key already guarantees this path runs at most once
  // per successful commit).
  insertForSale(ctx: TenantSessionContext, input: InsertSalePaymentInput): Promise<PaymentRecord>;

  // Used by the standalone recordPayment use case -- its OWN idempotency
  // key, `ON CONFLICT (structure_id, idempotency_key) DO NOTHING
  // RETURNING *`, same arbiter pattern as confirmSale/issueInvoiceForSale.
  tryInsertStandalone(
    ctx: TenantSessionContext,
    input: InsertStandalonePaymentInput
  ): Promise<PaymentFullRecord | null>;

  findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<PaymentFullRecord | null>;

  findById(ctx: TenantSessionContext, paymentId: string): Promise<PaymentFullRecord | null>;

  list(ctx: TenantSessionContext, filter: ListPaymentsFilter): Promise<PaymentFullRecord[]>;

  // C1 fix: conditional on `voided_at IS NULL` in the SAME statement --
  // returns null (not a row) when the payment was ALREADY voided, so two
  // concurrent voids can't both succeed and both debit the sale/invoice.
  markVoided(ctx: TenantSessionContext, paymentId: string, voidedAt: Date): Promise<PaymentFullRecord | null>;

  insertAllocation(ctx: TenantSessionContext, input: AllocationInput): Promise<void>;

  findAllocationByPaymentId(
    ctx: TenantSessionContext,
    paymentId: string
  ): Promise<AllocationRecord | null>;
}

export interface InvoiceRecord {
  id: string;
  saleId: string | null;
  customerId: string | null;
  docNumber: string;
  fiscalYear: number;
  currencyCode: string;
  totalMinor: bigint;
  paidMinor: bigint;
  status: InvoiceStatus;
  issuedAt: Date | null;
  dueAt: Date | null;
  createdBy: string;
}

export interface InsertInvoiceInput {
  saleId: string | null;
  customerId: string | null;
  docNumber: string;
  fiscalYear: number;
  currencyCode: string;
  totalMinor: bigint;
  paidMinor: bigint;
  status: InvoiceStatus;
  issuedAt: Date;
  createdBy: string;
}

export interface InvoicePaymentProgressDelta {
  // Signed delta, applied ATOMICALLY in SQL against the row's current
  // value (C1 fix) -- never a JS read-modify-write.
  deltaMinor: bigint;
}

export interface ListInvoicesFilter {
  createdBy?: string;
  status?: InvoiceStatus;
  // L-b fix (security-reviewer follow-up) -- see ListPaymentsFilter.saleIds.
  saleIds?: string[];
}

export interface OutstandingSummary {
  totalMinor: bigint;
  overdueMinor: bigint;
}

export interface InvoiceRepository {
  // `ON CONFLICT (structure_id, sale_id) WHERE sale_id IS NOT NULL DO
  // NOTHING RETURNING *` (migration 0011) -- returns null on conflict
  // (another invoice already exists for this sale).
  tryInsertForSale(
    ctx: TenantSessionContext,
    input: InsertInvoiceInput
  ): Promise<InvoiceRecord | null>;

  findBySaleId(ctx: TenantSessionContext, saleId: string): Promise<InvoiceRecord | null>;

  findById(ctx: TenantSessionContext, invoiceId: string): Promise<InvoiceRecord | null>;

  list(ctx: TenantSessionContext, filter: ListInvoicesFilter): Promise<InvoiceRecord[]>;

  // ATOMIC (C1 fix): increment + bounds check (0 <= paid_minor <=
  // total_minor) in one statement against the row's current value.
  // Returns null when the bounds check fails or the row doesn't exist.
  updatePaymentProgress(
    ctx: TenantSessionContext,
    invoiceId: string,
    delta: InvoicePaymentProgressDelta
  ): Promise<InvoiceRecord | null>;

  // Every sale_id that already has an invoice -- used by getReceivables to
  // avoid double-counting a sale's balance once an invoice has taken over
  // tracking it.
  listSaleIdsWithInvoice(ctx: TenantSessionContext): Promise<string[]>;

  // Aggregate outstanding balance across invoices with status in
  // ('issued', 'partially_paid') -- point-in-time, no date filter. `dont
  // échu` = the subset with `due_at < now()`.
  sumOutstanding(ctx: TenantSessionContext): Promise<OutstandingSummary>;
}
