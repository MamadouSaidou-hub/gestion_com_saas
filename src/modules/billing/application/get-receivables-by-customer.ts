import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { salesService } from "@/modules/sales";
import type { InvoiceRepository } from "./ports";
import type { CustomerReceivableDto } from "./dto";

// ---------------------------------------------------------------------------
// getReceivablesByCustomer -- the clients screen's per-customer balance.
// REUSES getReceivables' own two disjoint sources (confirmed, uninvoiced
// open sales + outstanding invoices) instead of recomputing what counts as
// "outstanding" -- see get-receivables.ts's header comment for why those two
// sources are disjoint by construction (an invoiced sale stops being
// tracked by the sale's own balance once an invoice takes over).
//
// `storeScope` (null = every store) narrows both sources to one store:
//  - open sales -- filtered directly by their own `warehouseId`.
//  - invoices -- invoices have NO warehouse_id column of their own (see
//    db/schema/billing.ts); a store-scoped gerant can only ever "collect a
//    receivable that arose in their store" via the LINKED sale's store, so
//    a standalone invoice (no sale_id) is excluded entirely when
//    store-scoped -- there is no store it could be attributed to. This is a
//    documented judgment call, not an oversight: flag for security-reviewer
//    if a future workflow needs standalone invoices to be store-attributable.
// ---------------------------------------------------------------------------
export async function getReceivablesByCustomer(
  ctx: TenantSessionContext,
  storeScope: string | null,
  invoiceRepo: InvoiceRepository
): Promise<CustomerReceivableDto[]> {
  assertCan(ctx.actor, "customer:read");

  const [openSales, saleIdsWithInvoice, outstandingInvoices] = await Promise.all([
    salesService.listOpenSalesForBilling(ctx),
    invoiceRepo.listSaleIdsWithInvoice(ctx),
    invoiceRepo.listOutstanding(ctx),
  ]);

  const invoicedSaleIds = new Set(saleIdsWithInvoice);
  const now = new Date();
  const DUE_SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const dueSoonThreshold = new Date(now.getTime() + DUE_SOON_WINDOW_MS);
  const byCustomer = new Map<string, { outstandingMinor: bigint; overdueMinor: bigint; dueSoonMinor: bigint }>();

  const bump = (customerId: string | null, amount: bigint, overdue: bigint, dueSoon: bigint) => {
    if (!customerId || amount <= 0n) {
      return;
    }
    const entry = byCustomer.get(customerId) ?? { outstandingMinor: 0n, overdueMinor: 0n, dueSoonMinor: 0n };
    entry.outstandingMinor += amount;
    entry.overdueMinor += overdue;
    entry.dueSoonMinor += dueSoon;
    byCustomer.set(customerId, entry);
  };

  for (const sale of openSales) {
    if (invoicedSaleIds.has(sale.id)) {
      continue;
    }
    if (storeScope && sale.warehouseId !== storeScope) {
      continue;
    }
    const balance = moneyFromDto(sale.totalMinor) - moneyFromDto(sale.paidMinor);
    // A confirmed sale with no due date is never "overdue"/"due soon" by
    // itself -- only invoices carry a due_at.
    bump(sale.customerId, balance, 0n, 0n);
  }

  let invoiceWarehouseBySaleId: Record<string, string> = {};
  if (storeScope) {
    const saleIds = outstandingInvoices.map((inv) => inv.saleId).filter((id): id is string => id !== null);
    invoiceWarehouseBySaleId = await salesService.findWarehouseIdsForSaleIds(ctx, saleIds);
  }

  for (const invoice of outstandingInvoices) {
    if (storeScope) {
      const warehouseId = invoice.saleId ? invoiceWarehouseBySaleId[invoice.saleId] : undefined;
      if (warehouseId !== storeScope) {
        continue; // standalone invoice, or linked to a different store
      }
    }
    const balance = invoice.totalMinor - invoice.paidMinor;
    const overdue = invoice.dueAt && invoice.dueAt < now ? balance : 0n;
    const dueSoon = invoice.dueAt && invoice.dueAt >= now && invoice.dueAt <= dueSoonThreshold ? balance : 0n;
    bump(invoice.customerId, balance, overdue, dueSoon);
  }

  return Array.from(byCustomer.entries()).map(([customerId, totals]) => ({
    customerId,
    outstandingMinor: moneyToDto(totals.outstandingMinor),
    overdueMinor: moneyToDto(totals.overdueMinor),
    dueSoonMinor: moneyToDto(totals.dueSoonMinor),
  }));
}
