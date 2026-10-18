import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { salesService } from "@/modules/sales";
import { resolveCurrentUtcMonth } from "../domain/period";
import { pickHighestTierReached } from "../domain/tier";
import { RebateScaleNotFoundError } from "../domain/errors";
import type { RebateGrantDto } from "./dto";
import type { RebateRepository } from "./ports";
import { toRebateGrantDto } from "./mappers";

// ---------------------------------------------------------------------------
// calculateCustomerRebate -- "Calculer la ristourne du mois". Monthly,
// derived from Σ sale_lines.quantity for this customer's CONFIRMED,
// non-cancelled sales in the CURRENT UTC calendar month (D8/analytics
// convention) -- the month is derived from `now()` EVERY call, never
// stored as a counter: calling this again next month naturally computes a
// NEW period_label with no migration/reset step anywhere.
//
// Race-safe: `upsertMonthlyGrant`'s `ON CONFLICT (structure_id, scale_id,
// period_label) WHERE model = 'monthly' DO UPDATE` (migration 0016's own
// partial unique index) means two concurrent calls for the SAME
// customer+month resolve to ONE row, never a duplicate.
//
// No tier reached -> returns null, no write, no audit (same "no-op" rule
// as the supplier side's manual check).
// ---------------------------------------------------------------------------
export async function calculateCustomerRebate(
  ctx: TenantSessionContext,
  customerId: string,
  repo: RebateRepository
): Promise<RebateGrantDto | null> {
  assertCan(ctx.actor, "rebate:grant");

  const scale = await repo.findScaleByCustomerId(ctx, customerId);
  if (!scale || !scale.isActive) {
    throw new RebateScaleNotFoundError();
  }

  const tiers = await repo.listTiers(ctx, scale.id);
  const period = resolveCurrentUtcMonth();
  const countedQty = await salesService.sumConfirmedQuantityForCustomerInWindow(
    ctx,
    customerId,
    period.start,
    period.end
  );

  const tier = pickHighestTierReached(tiers, countedQty);
  if (!tier) {
    return null; // below every threshold this month -- no write, no audit
  }

  const totalRebateMinor = countedQty.multiplyToMinor(tier.rebatePerUnitMinor);
  const grantedAt = new Date();

  const grant = await repo.upsertMonthlyGrant(ctx, {
    scaleId: scale.id,
    periodLabel: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    countedQty,
    tierThresholdQty: tier.thresholdQty,
    rebatePerUnitMinor: tier.rebatePerUnitMinor,
    totalRebateMinor,
    currencyCode: scale.currencyCode,
    grantedAt,
  });

  await ctx.audit.append({
    action: "rebate.granted",
    targetType: "rebate_scale",
    targetId: scale.id,
    payload: {
      periodLabel: period.label,
      countedQty: countedQty.toDbString(),
      totalRebateMinor: totalRebateMinor.toString(),
    },
  });

  return toRebateGrantDto(grant);
}
