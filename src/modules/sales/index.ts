import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { salesRepository } from "./infrastructure/sales-repository";
import * as useCases from "./application";
import type { ConfirmSaleInput, RecordPaymentProgressInput } from "./application";

// ---------------------------------------------------------------------------
// sales/index.ts -- the ONLY surface another module (or this module's own
// api/, once built) is allowed to import from. Composition root: wires the
// concrete (drizzle) repository into the pure use cases.
//
// `confirmSale` is the top-level use case per the transaction convention
// (docs/platform.md): the FUTURE api/ Server Action will open
// `withTenantSession` itself and call `salesService.confirmSale(ctx, ...)`.
// `getSaleForBilling`/`recordPaymentProgress` are ctx-based primitives for
// OTHER modules (billing) to call with THEIR OWN already-open ctx -- same
// convention as inventory's applyStockOut/reverseStockOut.
// ---------------------------------------------------------------------------

export const salesService = {
  confirmSale: (ctx: TenantSessionContext, input: ConfirmSaleInput) =>
    useCases.confirmSale(ctx, input, salesRepository),
  getSaleForBilling: (ctx: TenantSessionContext, saleId: string) =>
    useCases.getSaleForBilling(ctx, saleId, salesRepository),
  listOpenSalesForBilling: (ctx: TenantSessionContext) =>
    useCases.listOpenSalesForBilling(ctx, salesRepository),
  getCreatedByForSales: (ctx: TenantSessionContext, saleIds: string[]) =>
    useCases.getCreatedByForSales(ctx, saleIds, salesRepository),
  listSaleIdsCreatedBy: (ctx: TenantSessionContext, userId: string) =>
    useCases.listSaleIdsCreatedBy(ctx, userId, salesRepository),
  recordPaymentProgress: (ctx: TenantSessionContext, input: RecordPaymentProgressInput) =>
    useCases.recordPaymentProgress(ctx, input, salesRepository),
};

export type {
  ConfirmSaleInput,
  ConfirmSaleLineInput,
  ConfirmSalePaymentInput,
  ConfirmSaleResult,
  ConfirmSaleLineResult,
  PaymentMethod,
  SaleForBilling,
  RecordPaymentProgressInput,
  PaymentProgressResult,
} from "./application";
export {
  InvalidSaleInputError,
  ProductNotSellableError,
  AnonymousCreditSaleError,
  PaymentExceedsTotalError,
  IdempotencyKeyReuseError,
  DiscountLimitExceededError,
} from "./domain";
