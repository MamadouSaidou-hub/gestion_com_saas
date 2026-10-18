import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto, type MoneyMinorDto } from "@/platform/dto/money";
import type { SalesRepository, SaleStatus, SalePaymentStatus } from "./ports";

// Narrow read-only shape for billing's use cases (recordPayment,
// issueInvoiceForSale) -- NOT independently exposed as a user-facing
// action, so no `assertCan` here (same convention as inventory's
// applyStockOut/reverseStockOut): the caller (billing) already checked its
// own permission (`payment:record`/`invoice:issue`) before reaching this.
export interface SaleForBilling {
  id: string;
  customerId: string | null;
  currencyCode: string;
  status: SaleStatus;
  totalMinor: MoneyMinorDto;
  paidMinor: MoneyMinorDto;
  paymentStatus: SalePaymentStatus;
  createdBy: string;
  fiscalYear: number | null;
  ticketNumber: string | null;
}

export async function getSaleForBilling(
  ctx: TenantSessionContext,
  saleId: string,
  repo: SalesRepository
): Promise<SaleForBilling | null> {
  const sale = await repo.findById(ctx, saleId);
  if (!sale) {
    return null;
  }
  return {
    id: sale.id,
    customerId: sale.customerId,
    currencyCode: sale.currencyCode,
    status: sale.status,
    totalMinor: moneyToDto(sale.totalMinor),
    paidMinor: moneyToDto(sale.paidMinor),
    paymentStatus: sale.paymentStatus,
    createdBy: sale.createdBy,
    fiscalYear: sale.fiscalYear,
    ticketNumber: sale.ticketNumber?.toString() ?? null,
  };
}
