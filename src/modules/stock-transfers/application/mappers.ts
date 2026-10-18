import { moneyToDto } from "@/platform/dto/money";
import type { TransferDto, TransferLineDto, StockCountDto, StockCountLineDto, VarianceLineDto } from "./dto";
import type {
  TransferHeaderRecord,
  TransferLineRecord,
  StockCountHeaderRecord,
  StockCountLineRecord,
  VarianceLineRow,
} from "./ports";

export function toTransferLineDto(record: TransferLineRecord): TransferLineDto {
  return {
    productId: record.productId,
    quantity: record.quantity.toDbString(),
    unitCostMinor: moneyToDto(record.unitCostMinor),
    lineNo: record.lineNo,
  };
}

export function toTransferDto(
  header: TransferHeaderRecord,
  lines: TransferLineRecord[],
  replayed: boolean
): TransferDto {
  return {
    id: header.id,
    reference: header.reference,
    fiscalYear: header.fiscalYear,
    fromWarehouseId: header.fromWarehouseId,
    toWarehouseId: header.toWarehouseId,
    status: header.status,
    currencyCode: header.currencyCode,
    createdAt: header.createdAt.toISOString(),
    receivedAt: header.receivedAt?.toISOString() ?? null,
    cancelledAt: header.cancelledAt?.toISOString() ?? null,
    cancelReason: header.cancelReason,
    lines: lines.sort((a, b) => a.lineNo - b.lineNo).map(toTransferLineDto),
    replayed,
  };
}

export function toStockCountLineDto(record: StockCountLineRecord): StockCountLineDto {
  return {
    productId: record.productId,
    theoreticalQty: record.theoreticalQty.toDbString(),
    countedQty: record.countedQty?.toDbString() ?? null,
    varianceQty: record.varianceQty?.toDbString() ?? null,
    unitCostMinor: record.varianceValueMinor !== null ? moneyToDto(record.unitCostMinor) : null,
    varianceValueMinor: record.varianceValueMinor !== null ? moneyToDto(record.varianceValueMinor) : null,
  };
}

export function toStockCountDto(
  header: StockCountHeaderRecord,
  lines: StockCountLineRecord[],
  replayed: boolean
): StockCountDto {
  return {
    id: header.id,
    warehouseId: header.warehouseId,
    status: header.status,
    createdAt: header.createdAt.toISOString(),
    validatedAt: header.validatedAt?.toISOString() ?? null,
    lines: lines.map(toStockCountLineDto),
    replayed,
  };
}

export function toVarianceLineDto(row: VarianceLineRow): VarianceLineDto {
  return {
    stockCountId: row.stockCountId,
    warehouseId: row.warehouseId,
    productId: row.productId,
    theoreticalQty: row.theoreticalQty.toDbString(),
    countedQty: row.countedQty.toDbString(),
    varianceQty: row.varianceQty.toDbString(),
    unitCostMinor: moneyToDto(row.unitCostMinor),
    varianceValueMinor: moneyToDto(row.varianceValueMinor),
    validatedAt: row.validatedAt.toISOString(),
  };
}
