import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { salesService } from "@/modules/sales";
import { purchasingService } from "@/modules/purchasing";
import { moneyToDto } from "@/platform/dto/money";
import { Quantity } from "@/modules/inventory";
import { resolveCurrentUtcMonth } from "../domain/period";
import { pickHighestTierReached, pickNextTier } from "../domain/tier";
import type { RebateProgressDto } from "./dto";
import type { RebateRepository, RebateTierRecord } from "./ports";
import { toRebateScaleDto, toRebateTierDto } from "./mappers";

const EPOCH = new Date(0);

function buildProgress(
  scaleDto: ReturnType<typeof toRebateScaleDto>,
  countedQty: Quantity,
  periodLabel: string | null,
  periodStart: Date,
  periodEnd: Date | null,
  tiers: RebateTierRecord[]
): RebateProgressDto {
  const tierReached = pickHighestTierReached(tiers, countedQty);
  const nextTier = pickNextTier(tiers, countedQty);
  return {
    scale: scaleDto,
    countedQty: countedQty.toDbString(),
    periodLabel,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd?.toISOString() ?? null,
    tierReached: tierReached ? toRebateTierDto(tierReached) : null,
    projectedRebateMinor: tierReached
      ? moneyToDto(countedQty.multiplyToMinor(tierReached.rebatePerUnitMinor))
      : null,
    nextTier: nextTier ? toRebateTierDto(nextTier) : null,
    unitsToNextTier: nextTier ? nextTier.thresholdQty.subtract(countedQty).toDbString() : null,
  };
}

// getCustomerRebateProgress -- read-only "Barème" view for the customer
// detail screen. Live progress: units so far THIS CALENDAR MONTH (derived
// from now(), never stored), tier reached, projected rebate, next tier.
export async function getCustomerRebateProgress(
  ctx: TenantSessionContext,
  customerId: string,
  repo: RebateRepository
): Promise<RebateProgressDto | null> {
  assertCan(ctx.actor, "rebate:read");
  const scale = await repo.findScaleByCustomerId(ctx, customerId);
  if (!scale) return null;

  const tiers = await repo.listTiers(ctx, scale.id);
  const period = resolveCurrentUtcMonth();
  const countedQty = await salesService.sumConfirmedQuantityForCustomerInWindow(
    ctx,
    customerId,
    period.start,
    period.end
  );

  return buildProgress(toRebateScaleDto(scale, tiers), countedQty, period.label, period.start, period.end, tiers);
}

// getSupplierRebateProgress -- same read-only view for the supplier
// detail screen. "Since last tier"/cycle start, open-ended (periodEnd:
// null -- "so far", not a closed window).
export async function getSupplierRebateProgress(
  ctx: TenantSessionContext,
  supplierId: string,
  repo: RebateRepository
): Promise<RebateProgressDto | null> {
  assertCan(ctx.actor, "rebate:read");
  const scale = await repo.findScaleBySupplierId(ctx, supplierId);
  if (!scale) return null;

  const tiers = await repo.listTiers(ctx, scale.id);
  const cycleStart = scale.cycleStartedAt ?? EPOCH;
  const countedQty = await purchasingService.sumDeliveredQuantitySince(ctx, supplierId, cycleStart);

  return buildProgress(toRebateScaleDto(scale, tiers), countedQty, null, cycleStart, null, tiers);
}
