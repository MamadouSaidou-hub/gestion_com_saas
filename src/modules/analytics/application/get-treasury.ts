import { assertCan, can, resolveStoreScope } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { billingService } from "@/modules/billing";
import { purchasingService } from "@/modules/purchasing";
import { resolvePeriodWindow } from "../domain/period";
import type { AnalyticsRepository } from "./ports";
import type { GetTreasuryInput, TreasuryDto } from "./dto";

// ---------------------------------------------------------------------------
// getTreasury -- consolidated money view for the "Trésorerie" screen.
// Filtered by period x store, same resolveStoreScope convention as
// getDashboard/getHeadline: a store-scoped actor (gerant) ALWAYS gets
// their own store, an unscoped actor gets the requested store or every
// store.
//
// "Don't fetch what the actor may not see" (same discipline as
// getDashboard's `dashboard:read_financials` gate): the supplier side
// (payments made to suppliers, debt owed) is consolidated at TENANT
// level by product decision (db/README entry 2y) -- a store-scoped
// manager has NOTHING store-attributable to show there, so those two
// queries are simply never issued for them. The `supplier` key stays
// `null` for them, not a zeroed-out object.
// ---------------------------------------------------------------------------
export async function getTreasury(
  ctx: TenantSessionContext,
  input: GetTreasuryInput,
  repo: AnalyticsRepository
): Promise<TreasuryDto> {
  assertCan(ctx.actor, "treasury:read");

  const referenceDate = input.referenceDate ?? new Date();
  const window = resolvePeriodWindow(input.period, referenceDate);
  const current = { start: window.currentStart, end: window.currentEnd };
  const storeScope = resolveStoreScope(ctx.actor, input.warehouseId);

  const [cashSalesMinor, receivableCollectionsMinor, receivablesPerCustomer] = await Promise.all([
    repo.getCashSalesTotal(ctx, current, storeScope),
    repo.getReceivableCollectionsTotal(ctx, current, storeScope),
    // Reuses billing's own definition of "outstanding" (never duplicated
    // here) -- store-scoped the same way the clients screen already is.
    billingService.getReceivablesByCustomer(ctx, storeScope),
  ]);

  const receivablesOwedToUsMinor = receivablesPerCustomer.reduce(
    (acc, row) => acc + moneyFromDto(row.outstandingMinor),
    0n
  );

  let supplier: TreasuryDto["supplier"] = null;
  if (storeScope === null && can(ctx.actor, "delivery:read")) {
    const [paymentsMadeMinor, debt] = await Promise.all([
      repo.getSupplierPaymentsTotal(ctx, current),
      purchasingService.getTotalSupplierDebt(ctx),
    ]);
    supplier = {
      paymentsMadeMinor: moneyToDto(paymentsMadeMinor),
      debtOwedMinor: debt.debtMinor,
    };
  }

  return {
    period: input.period,
    windowStart: window.currentStart.toISOString(),
    windowEnd: window.currentEnd.toISOString(),
    cashSalesMinor: moneyToDto(cashSalesMinor),
    receivableCollectionsMinor: moneyToDto(receivableCollectionsMinor),
    totalEncaisseMinor: moneyToDto(cashSalesMinor + receivableCollectionsMinor),
    receivablesOwedToUsMinor: moneyToDto(receivablesOwedToUsMinor),
    supplier,
  };
}
