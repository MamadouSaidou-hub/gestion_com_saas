import { moneyToDto } from "@/platform/dto/money";
import type { StockLevelDto, StockMovementDto } from "./dto";
import type { StockLevelRecord, StockMovementRecord } from "./ports";

export function toStockLevelDto(record: StockLevelRecord): StockLevelDto {
  return {
    productId: record.productId,
    warehouseId: record.warehouseId,
    quantity: record.quantity.toDbString(),
    avgCostMinor: moneyToDto(record.avgCostMinor),
    currencyCode: record.currencyCode,
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toMovementDto(record: StockMovementRecord): StockMovementDto {
  return {
    id: record.id.toString(),
    productId: record.productId,
    warehouseId: record.warehouseId,
    direction: record.direction,
    quantity: record.quantity.toDbString(),
    unitCostMinor: moneyToDto(record.unitCostMinor),
    currencyCode: record.currencyCode,
    reason: record.reason,
    saleId: record.saleId,
    occurredAt: record.occurredAt.toISOString(),
    createdBy: record.createdBy,
  };
}
