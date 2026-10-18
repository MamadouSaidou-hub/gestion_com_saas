import { moneyToDto } from "@/platform/dto/money";
import type { DeliveryDto, DeliveryLineDto, SupplierPaymentDto, SupplierDebtDto } from "./dto";
import type { DeliveryRecord, DeliveryLineRecord, SupplierPaymentRecord } from "./ports";

export function toDeliveryLineDto(record: DeliveryLineRecord): DeliveryLineDto {
  return {
    id: record.id,
    productId: record.productId,
    quantity: record.quantity.toDbString(),
    unitCostMinor: moneyToDto(record.unitCostMinor),
    lineTotalMinor: moneyToDto(record.lineTotalMinor),
    lineNo: record.lineNo,
  };
}

export function toDeliveryDto(
  record: DeliveryRecord,
  lines: DeliveryLineRecord[],
  replay: boolean
): DeliveryDto {
  return {
    id: record.id,
    supplierId: record.supplierId,
    warehouseId: record.warehouseId,
    reference: record.reference,
    fiscalYear: record.fiscalYear,
    currencyCode: record.currencyCode,
    totalMinor: moneyToDto(record.totalMinor),
    paidMinor: moneyToDto(record.paidMinor),
    paymentStatus: record.paymentStatus,
    dueAt: record.dueAt?.toISOString() ?? null,
    receivedAt: record.receivedAt?.toISOString() ?? null,
    lines: lines.map(toDeliveryLineDto),
    replay,
  };
}

export function toSupplierPaymentDto(record: SupplierPaymentRecord): SupplierPaymentDto {
  return {
    id: record.id,
    supplierId: record.supplierId,
    deliveryId: record.deliveryId,
    amountMinor: moneyToDto(record.amountMinor),
    currencyCode: record.currencyCode,
    method: record.method,
    reference: record.reference,
    paidAt: record.paidAt.toISOString(),
    voidedAt: record.voidedAt?.toISOString() ?? null,
  };
}

export function toSupplierDebtDto(supplierId: string, debtMinor: bigint): SupplierDebtDto {
  return { supplierId, debtMinor: moneyToDto(debtMinor) };
}
