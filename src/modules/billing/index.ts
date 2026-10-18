import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { taxSettingsRepository } from "./infrastructure/tax-settings-repository";
import { documentCounterRepository } from "./infrastructure/document-counter-repository";
import { paymentRepository } from "./infrastructure/payment-repository";
import { invoiceRepository } from "./infrastructure/invoice-repository";
import * as useCases from "./application";
import type { InsertSalePaymentInput, RecordPaymentInput, InvoiceStatus } from "./application";

// ---------------------------------------------------------------------------
// billing/index.ts -- the ONLY surface another module is allowed to import
// from. Composition root wiring the concrete (drizzle) repositories into
// the pure use cases.
//
// Two generations of use cases, both exposed here:
//  - ctx-based primitives `confirmSale` calls with ITS OWN ctx
//    (getVatRate, allocateTicketNumber, recordSalePayment) -- step 3.
//  - standalone, top-level use cases with their OWN transaction
//    (recordPayment, issueInvoiceForSale, voidPayment, read side) -- step 4.
// ---------------------------------------------------------------------------

export const billingService = {
  // --- ctx-based primitives (step 3) ---
  getVatRate: (ctx: TenantSessionContext) => useCases.getVatRate(ctx, taxSettingsRepository),
  allocateTicketNumber: (ctx: TenantSessionContext, fiscalYear: number) =>
    useCases.allocateTicketNumber(ctx, fiscalYear, documentCounterRepository),
  recordSalePayment: (ctx: TenantSessionContext, input: InsertSalePaymentInput) =>
    useCases.recordSalePayment(ctx, input, paymentRepository),

  // --- standalone, top-level use cases (step 4) ---
  recordPayment: (ctx: TenantSessionContext, input: RecordPaymentInput) =>
    useCases.recordPayment(ctx, input, { paymentRepo: paymentRepository, invoiceRepo: invoiceRepository }),
  issueInvoiceForSale: (ctx: TenantSessionContext, saleId: string) =>
    useCases.issueInvoiceForSale(ctx, saleId, {
      invoiceRepo: invoiceRepository,
      taxSettingsRepo: taxSettingsRepository,
      documentCounterRepo: documentCounterRepository,
    }),
  voidPayment: (ctx: TenantSessionContext, paymentId: string) =>
    useCases.voidPayment(ctx, paymentId, { paymentRepo: paymentRepository, invoiceRepo: invoiceRepository }),
  listInvoices: (ctx: TenantSessionContext, filter: { status?: InvoiceStatus } = {}) =>
    useCases.listInvoices(ctx, filter, invoiceRepository),
  getInvoice: (ctx: TenantSessionContext, invoiceId: string) =>
    useCases.getInvoice(ctx, invoiceId, invoiceRepository),
  listPayments: (ctx: TenantSessionContext, requestedWarehouseId?: string | null) =>
    useCases.listPayments(ctx, paymentRepository, requestedWarehouseId),
  getReceivables: (ctx: TenantSessionContext) => useCases.getReceivables(ctx, invoiceRepository),
};

export type {
  InsertSalePaymentInput,
  PaymentRecord,
  PaymentMethod,
  InvoiceStatus,
  InvoiceDto,
  PaymentDto,
  ReceivablesSummaryDto,
  RecordPaymentInput,
} from "./application";
export {
  SaleNotFoundError,
  SaleNotConfirmedError,
  InvoiceNotFoundError,
  PaymentNotFoundError,
  PaymentAlreadyVoidedError,
  OverpaymentError,
  InvalidPaymentInputError,
} from "./domain";
