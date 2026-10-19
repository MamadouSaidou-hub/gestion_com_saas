import type { MoneyMinorDto } from "@/platform/dto/money";
import type { DeliveryPaymentStatus } from "./ports";

export interface RecordDeliveryLineInput {
  productId: string;
  quantity: string; // numeric(18,4) string
  unitCostMinor: MoneyMinorDto;
}

export interface RecordDeliveryInput {
  idempotencyKey: string;
  supplierId: string;
  warehouseId: string;
  currencyCode: string;
  lines: RecordDeliveryLineInput[];
  dueAt?: string | null; // ISO 8601
}

export interface DeliveryLineDto {
  id: string;
  productId: string;
  quantity: string;
  unitCostMinor: MoneyMinorDto;
  lineTotalMinor: MoneyMinorDto;
  lineNo: number;
}

export interface DeliveryDto {
  id: string;
  supplierId: string;
  warehouseId: string;
  reference: string;
  fiscalYear: number;
  currencyCode: string;
  totalMinor: MoneyMinorDto;
  paidMinor: MoneyMinorDto;
  paymentStatus: DeliveryPaymentStatus;
  dueAt: string | null;
  receivedAt: string | null;
  lines: DeliveryLineDto[];
  replay: boolean;
}

export type SupplierPaymentMethod = "cash" | "mobile_money" | "bank_transfer" | "card" | "other";

export interface RecordSupplierPaymentInput {
  idempotencyKey: string;
  supplierId: string;
  deliveryId?: string | null;
  amountMinor: MoneyMinorDto;
  method: SupplierPaymentMethod;
  reference?: string | null;
}

export interface SupplierPaymentDto {
  id: string;
  supplierId: string;
  deliveryId: string | null;
  amountMinor: MoneyMinorDto;
  currencyCode: string;
  method: string;
  reference: string | null;
  paidAt: string;
  voidedAt: string | null;
}

export interface SupplierDebtDto {
  supplierId: string;
  debtMinor: MoneyMinorDto;
}

export interface SupplierDebtTotalDto {
  debtMinor: MoneyMinorDto;
}
