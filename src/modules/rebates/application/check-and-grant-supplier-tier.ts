import { purchasingService } from "@/modules/purchasing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { pickHighestTierReached } from "../domain/tier";
import type { RebateGrantDto } from "./dto";
import type { RebateRepository } from "./ports";
import { toRebateGrantDto } from "./mappers";

export interface CheckSupplierTierInput {
  supplierId: string;
}

const EPOCH = new Date(0);

// ---------------------------------------------------------------------------
// evaluateAndGrantSupplierTier -- the shared core for BOTH the auto trigger
// (called from purchasing's recordDelivery flow, inside the SAME
// transaction -- see purchasing/api/actions.ts's header comment) and the
// manual "vérifier le palier" command. No permission check here -- the
// TWO CALLERS below gate it differently (auto: none, it's a system side
// effect of an already-authorized delivery; manual: `rebate:grant`).
//
// Supplier side, cyclic: Σ supplier_delivery_lines.quantity of non-
// cancelled deliveries with received_at STRICTLY GREATER than
// cycle_started_at (so the delivery that closed a cycle is never
// recounted -- there is no cycle-closing use case in this phase, so
// cycle_started_at never actually advances yet; `scale.cycleStartedAt
// ?? EPOCH` is the "since forever" fallback for a scale created with no
// explicit cycle start).
//
// `lockScaleForUpdate` (SELECT ... FOR UPDATE, src/platform/money/
// ordered-lock.ts) is what makes "two concurrent deliveries crossing a
// threshold grant exactly once" hold: a second concurrent call for the
// SAME scale blocks on this lock until the first transaction commits (or
// rolls back), then re-reads the ALREADY-COMMITTED highest-granted-tier
// state before deciding whether there is anything new to grant.
//
// The tier granted is the HIGHEST tier reached (not incremental) -- if no
// NEW tier (strictly higher than whatever was already granted this cycle)
// is reached, this is a no-op: no write, no audit.
// ---------------------------------------------------------------------------
export async function evaluateAndGrantSupplierTier(
  ctx: TenantSessionContext,
  input: CheckSupplierTierInput,
  repo: RebateRepository,
  trigger: "manual" | "auto",
  grantedBy: string | null
): Promise<RebateGrantDto | null> {
  const scale = await repo.findScaleBySupplierId(ctx, input.supplierId);
  if (!scale || !scale.isActive) {
    return null;
  }

  const locked = await repo.lockScaleForUpdate(ctx, scale.id);
  if (!locked) {
    return null;
  }

  const cycleStart = locked.cycleStartedAt ?? EPOCH;
  const tiers = await repo.listTiers(ctx, scale.id);
  const countedQty = await purchasingService.sumDeliveredQuantitySince(ctx, input.supplierId, cycleStart);

  const tier = pickHighestTierReached(tiers, countedQty);
  if (!tier) {
    return null; // below every threshold -- no write, no audit
  }

  const alreadyGrantedThreshold = await repo.findHighestGrantedTierThresholdSince(
    ctx,
    scale.id,
    cycleStart
  );
  if (alreadyGrantedThreshold && !alreadyGrantedThreshold.lessThan(tier.thresholdQty)) {
    return null; // this tier (or a higher one) was already granted this cycle
  }

  const totalRebateMinor = countedQty.multiplyToMinor(tier.rebatePerUnitMinor);
  const grantedAt = new Date();

  const grant = await repo.insertCyclicGrant(ctx, {
    scaleId: scale.id,
    periodStart: cycleStart,
    periodEnd: grantedAt,
    countedQty,
    tierThresholdQty: tier.thresholdQty,
    rebatePerUnitMinor: tier.rebatePerUnitMinor,
    totalRebateMinor,
    currencyCode: scale.currencyCode,
    grantedAt,
    trigger,
    grantedBy,
  });

  await ctx.audit.append({
    action: "rebate.granted",
    targetType: "rebate_scale",
    targetId: scale.id,
    payload: {
      trigger,
      countedQty: countedQty.toDbString(),
      totalRebateMinor: totalRebateMinor.toString(),
    },
  });

  return toRebateGrantDto(grant);
}

// Auto path -- called from purchasing's Server Action with the delivery's
// own transaction ctx, no permission check (system side effect).
export async function checkAndGrantSupplierTier(
  ctx: TenantSessionContext,
  input: CheckSupplierTierInput,
  repo: RebateRepository
): Promise<RebateGrantDto | null> {
  return evaluateAndGrantSupplierTier(ctx, input, repo, "auto", null);
}
