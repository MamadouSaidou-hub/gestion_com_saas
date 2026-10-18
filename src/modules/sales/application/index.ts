export { confirmSale } from "./confirm-sale";
export { getSaleForBilling, type SaleForBilling } from "./get-sale-for-billing";
export { listOpenSalesForBilling } from "./list-open-sales-for-billing";
export { getCreatedByForSales } from "./get-created-by-for-sales";
export { listSaleIdsCreatedBy } from "./list-sale-ids-created-by";
export {
  recordPaymentProgress,
  type RecordPaymentProgressInput,
  type PaymentProgressResult,
} from "./record-payment-progress";
export type {
  ConfirmSaleInput,
  ConfirmSaleLineInput,
  ConfirmSalePaymentInput,
  ConfirmSaleResult,
  ConfirmSaleLineResult,
  PaymentMethod,
} from "./dto";
export type { SalesRepository, SaleHeaderRecord, SaleLineRecord } from "./ports";
