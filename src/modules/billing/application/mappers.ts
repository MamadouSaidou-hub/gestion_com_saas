import { moneyToDto } from "@/platform/dto/money";
import type { InvoiceDto, PaymentDto } from "./dto";
import type { InvoiceRecord, PaymentFullRecord } from "./ports";

export function toInvoiceDto(record: InvoiceRecord): InvoiceDto {
  return {
    id: record.id,
    saleId: record.saleId,
    customerId: record.customerId,
    docNumber: record.docNumber,
    fiscalYear: record.fiscalYear,
    currencyCode: record.currencyCode,
    totalMinor: moneyToDto(record.totalMinor),
    paidMinor: moneyToDto(record.paidMinor),
    status: record.status,
    issuedAt: record.issuedAt?.toISOString() ?? null,
    dueAt: record.dueAt?.toISOString() ?? null,
  };
}

export function toPaymentDto(record: PaymentFullRecord): PaymentDto {
  return {
    id: record.id,
    saleId: record.saleId,
    customerId: record.customerId,
    warehouseId: record.warehouseId,
    amountMinor: moneyToDto(record.amountMinor),
    currencyCode: record.currencyCode,
    method: record.method,
    receivedAt: record.receivedAt.toISOString(),
    reference: record.reference,
    voidedAt: record.voidedAt?.toISOString() ?? null,
  };
}
