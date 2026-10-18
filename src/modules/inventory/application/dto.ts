import type { MoneyMinorDto } from "@/platform/dto/money";

// Transport-safe shapes -- every bigint money column converted to a string
// (see @/platform/dto/money) and every bigint id (stock_movements.id) too,
// since bigint is not JSON-serializable across the RSC/Server-Action
// boundary. Quantity stays a plain numeric(18,4) string; callers that need
// to do arithmetic on it construct a `Quantity` via
// `Quantity.fromString(dto.quantity)` (never `Number()` it).

export interface StockLevelDto {
  productId: string;
  warehouseId: string;
  quantity: string;
  avgCostMinor: MoneyMinorDto;
  currencyCode: string;
  updatedAt: string; // ISO 8601
}

export interface StockMovementDto {
  id: string;
  productId: string;
  warehouseId: string;
  direction: "in" | "out";
  quantity: string;
  unitCostMinor: MoneyMinorDto;
  currencyCode: string;
  reason: string;
  saleId: string | null;
  occurredAt: string;
  createdBy: string;
}
