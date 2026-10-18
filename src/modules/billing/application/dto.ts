import type { MoneyMinorDto } from "@/platform/dto/money";

export type PaymentMethod = "cash" | "mobile_money" | "bank_transfer" | "card" | "other";
export type InvoiceStatus = "draft" | "issued" | "paid" | "partially_paid" | "cancelled";

export interface InvoiceDto {
  id: string;
  saleId: string | null;
  customerId: string | null;
  docNumber: string;
  fiscalYear: number;
  currencyCode: string;
  totalMinor: MoneyMinorDto;
  paidMinor: MoneyMinorDto;
  status: InvoiceStatus;
  issuedAt: string | null;
  dueAt: string | null;
}

export interface PaymentDto {
  id: string;
  saleId: string | null;
  customerId: string | null;
  warehouseId: string | null;
  amountMinor: MoneyMinorDto;
  currencyCode: string;
  method: string;
  receivedAt: string;
  reference: string | null;
  voidedAt: string | null;
}

export interface ReceivablesSummaryDto {
  totalOutstandingMinor: MoneyMinorDto;
  overdueMinor: MoneyMinorDto;
}

export interface CustomerReceivableDto {
  customerId: string;
  outstandingMinor: MoneyMinorDto;
  overdueMinor: MoneyMinorDto;
}

export interface RecordPaymentInput {
  idempotencyKey: string;
  amountMinor: MoneyMinorDto;
  method: PaymentMethod;
  reference?: string | null;
  saleId: string;
}
