import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { salesService } from "@/modules/sales";
import type { InvoiceRepository } from "./ports";
import type { ReceivablesSummaryDto } from "./dto";

// getReceivables -- the outstanding balances the dashboard needs. A
// point-in-time STOCK, not a windowed flow: no date filter on the balance
// itself. Gated on `dashboard:read_financials` (not just `invoice:read`/
// `payment:read`) since this is fundamentally a financial-visibility
// figure, consistent with its primary consumer (analytics' dashboard).
//
// Sums two disjoint sources to avoid double-counting:
//  - confirmed sales that are not fully paid AND have no invoice yet
//    (billing has no schema access to `sales` directly -- cross-module
//    boundary -- so this comes from `salesService.listOpenSalesForBilling`).
//  - invoices with status in ('issued', 'partially_paid') -- billing-owned
//    data, queried directly.
export async function getReceivables(
  ctx: TenantSessionContext,
  invoiceRepo: InvoiceRepository
): Promise<ReceivablesSummaryDto> {
  assertCan(ctx.actor, "dashboard:read_financials");

  const [openSales, saleIdsWithInvoice, invoiceSummary] = await Promise.all([
    salesService.listOpenSalesForBilling(ctx),
    invoiceRepo.listSaleIdsWithInvoice(ctx),
    invoiceRepo.sumOutstanding(ctx),
  ]);

  const invoicedSaleIds = new Set(saleIdsWithInvoice);
  let salesOutstandingMinor = 0n;
  for (const sale of openSales) {
    if (!invoicedSaleIds.has(sale.id)) {
      salesOutstandingMinor += moneyFromDto(sale.totalMinor) - moneyFromDto(sale.paidMinor);
    }
  }

  return {
    totalOutstandingMinor: moneyToDto(salesOutstandingMinor + invoiceSummary.totalMinor),
    overdueMinor: moneyToDto(invoiceSummary.overdueMinor),
  };
}
