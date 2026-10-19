import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { Quantity } from "@/modules/inventory";

export type RebateModel = "monthly" | "cyclic";
export type RebateMode = "cliff";
export type RebateGrantTrigger = "manual" | "auto";

export interface RebateScaleRecord {
  id: string;
  customerId: string | null;
  supplierId: string | null;
  model: RebateModel;
  mode: RebateMode;
  currencyCode: string;
  cycleStartedAt: Date | null;
  isActive: boolean;
}

export interface RebateTierRecord {
  id: string;
  scaleId: string;
  thresholdQty: Quantity;
  rebatePerUnitMinor: bigint;
}

export interface InsertRebateTierInput {
  thresholdQty: Quantity;
  rebatePerUnitMinor: bigint;
}

export interface RebateGrantRecord {
  id: string;
  scaleId: string;
  model: RebateModel;
  periodLabel: string | null;
  periodStart: Date;
  periodEnd: Date;
  countedQty: Quantity;
  tierThresholdQty: Quantity;
  rebatePerUnitMinor: bigint;
  totalRebateMinor: bigint;
  currencyCode: string;
  grantedAt: Date;
  grantedBy: string | null;
  trigger: RebateGrantTrigger;
}

export interface UpsertMonthlyGrantInput {
  scaleId: string;
  periodLabel: string;
  periodStart: Date;
  periodEnd: Date;
  countedQty: Quantity;
  tierThresholdQty: Quantity;
  rebatePerUnitMinor: bigint;
  totalRebateMinor: bigint;
  currencyCode: string;
  grantedAt: Date;
}

export interface InsertCyclicGrantInput {
  scaleId: string;
  periodStart: Date;
  periodEnd: Date;
  countedQty: Quantity;
  tierThresholdQty: Quantity;
  rebatePerUnitMinor: bigint;
  totalRebateMinor: bigint;
  currencyCode: string;
  grantedAt: Date;
  trigger: RebateGrantTrigger;
  grantedBy: string | null;
}

export interface InsertRebateScaleInput {
  customerId: string | null;
  supplierId: string | null;
  model: RebateModel;
  currencyCode: string;
  createdBy: string;
}

export interface RebateRepository {
  insertScale(ctx: TenantSessionContext, input: InsertRebateScaleInput): Promise<RebateScaleRecord>;
  findScaleByCustomerId(ctx: TenantSessionContext, customerId: string): Promise<RebateScaleRecord | null>;
  findScaleBySupplierId(ctx: TenantSessionContext, supplierId: string): Promise<RebateScaleRecord | null>;
  findScaleById(ctx: TenantSessionContext, scaleId: string): Promise<RebateScaleRecord | null>;
  // SELECT ... FOR UPDATE on the scale row -- the ordered-lock primitive
  // (src/platform/money/ordered-lock.ts) every concurrent cyclic grant
  // decision serializes on, so two deliveries crossing a threshold at the
  // same time grant exactly once.
  lockScaleForUpdate(ctx: TenantSessionContext, scaleId: string): Promise<RebateScaleRecord | null>;
  listTiers(ctx: TenantSessionContext, scaleId: string): Promise<RebateTierRecord[]>;
  insertTiers(ctx: TenantSessionContext, scaleId: string, tiers: InsertRebateTierInput[]): Promise<void>;
  // Race-safe upsert (`ON CONFLICT (structure_id, scale_id, period_label)
  // WHERE model = 'monthly' DO UPDATE`) -- two concurrent "Calculer la
  // ristourne du mois" calls for the same customer/month resolve to ONE
  // row, the second call's values winning (last write wins on the SAME
  // row, not a duplicate).
  upsertMonthlyGrant(ctx: TenantSessionContext, input: UpsertMonthlyGrantInput): Promise<RebateGrantRecord>;
  insertCyclicGrant(ctx: TenantSessionContext, input: InsertCyclicGrantInput): Promise<RebateGrantRecord>;
  // Highest tier threshold already granted for this scale within the
  // CURRENT cycle (grantedAt >= cycleStartedAtOrEpoch) -- null if none yet.
  // Used by checkAndGrantSupplierTier to decide whether a newly-reached
  // tier is actually NEW (not already granted) before inserting.
  findHighestGrantedTierThresholdSince(
    ctx: TenantSessionContext,
    scaleId: string,
    sinceInclusive: Date
  ): Promise<Quantity | null>;
  listGrantsByScale(ctx: TenantSessionContext, scaleId: string): Promise<RebateGrantRecord[]>;
  // Tenant-wide, across every scale -- the notifications derivation's "tier
  // reached" source. Joins back to rebate_scales for the customer/supplier
  // id so a notification can link to the right fiche without a second
  // round trip.
  listRecentGrants(
    ctx: TenantSessionContext,
    sinceExclusive: Date
  ): Promise<Array<RebateGrantRecord & { customerId: string | null; supplierId: string | null }>>;
}
