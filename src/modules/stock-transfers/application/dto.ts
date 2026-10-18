import type { MoneyMinorDto } from "@/platform/dto/money";

// Transport-safe shapes -- bigint money -> string, Quantity -> numeric
// string, same DTO-boundary discipline as every other module.

export interface CreateTransferLineInput {
  productId: string;
  quantity: string; // numeric(18,4) string -- never a number
}

export interface CreateTransferInput {
  idempotencyKey: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  lines: CreateTransferLineInput[];
}

export interface TransferLineDto {
  productId: string;
  quantity: string;
  unitCostMinor: MoneyMinorDto;
  lineNo: number;
}

export interface TransferDto {
  id: string;
  reference: string;
  fiscalYear: number;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: "in_transit" | "received" | "cancelled";
  currencyCode: string;
  createdAt: string;
  receivedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: TransferLineDto[];
  replayed: boolean;
}

export interface CancelTransferInput {
  transferId: string;
  reason: string | null;
}

export interface OpenStockCountLineInput {
  productId: string;
}

export interface OpenStockCountInput {
  idempotencyKey: string;
  warehouseId: string;
  productIds: string[];
}

export interface StockCountLineDto {
  productId: string;
  theoreticalQty: string;
  countedQty: string | null;
  varianceQty: string | null;
  unitCostMinor: MoneyMinorDto | null;
  varianceValueMinor: MoneyMinorDto | null;
}

export interface StockCountDto {
  id: string;
  warehouseId: string;
  status: "draft" | "validated" | "cancelled";
  createdAt: string;
  validatedAt: string | null;
  lines: StockCountLineDto[];
  replayed: boolean;
}

export interface ValidateStockCountLineInput {
  productId: string;
  countedQty: string;
}

export interface ValidateStockCountInput {
  stockCountId: string;
  lines: ValidateStockCountLineInput[];
}

export interface VarianceLineDto {
  stockCountId: string;
  warehouseId: string;
  productId: string;
  theoreticalQty: string;
  countedQty: string;
  varianceQty: string;
  unitCostMinor: MoneyMinorDto;
  varianceValueMinor: MoneyMinorDto;
  validatedAt: string;
}
