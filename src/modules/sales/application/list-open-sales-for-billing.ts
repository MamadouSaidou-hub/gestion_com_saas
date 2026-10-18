import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { SalesRepository } from "./ports";
import type { SaleForBilling } from "./get-sale-for-billing";

// Ctx-based primitive for billing's getReceivables -- all CONFIRMED sales
// that are not fully paid yet (unpaid or partial), regardless of window
// (receivables are a point-in-time stock, not a windowed flow). No
// `assertCan` here -- same convention as getSaleForBilling; the caller
// (billing, gated on `dashboard:read_financials`) already checked.
export async function listOpenSalesForBilling(
  ctx: TenantSessionContext,
  repo: SalesRepository
): Promise<SaleForBilling[]> {
  const rows = await repo.listOpen(ctx);
  return rows.map((row) => ({
    id: row.id,
    customerId: row.customerId,
    warehouseId: row.warehouseId,
    currencyCode: row.currencyCode,
    status: row.status,
    totalMinor: row.totalMinor.toString(),
    paidMinor: row.paidMinor.toString(),
    paymentStatus: row.paymentStatus,
    createdBy: row.createdBy,
    fiscalYear: row.fiscalYear,
    ticketNumber: row.ticketNumber?.toString() ?? null,
  }));
}
