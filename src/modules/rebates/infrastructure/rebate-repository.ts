import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { rebateScales, rebateTiers, rebateGrants } from "@/db/schema/rebates";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "@/modules/inventory";
import { lockRowForUpdate } from "@/platform/money/ordered-lock";
import type {
  RebateRepository,
  RebateScaleRecord,
  RebateTierRecord,
  RebateGrantRecord,
  InsertRebateScaleInput,
  InsertRebateTierInput,
  UpsertMonthlyGrantInput,
  InsertCyclicGrantInput,
} from "../application/ports";

type ScaleRow = typeof rebateScales.$inferSelect;
type TierRow = typeof rebateTiers.$inferSelect;
type GrantRow = typeof rebateGrants.$inferSelect;

function scaleToDomain(row: ScaleRow): RebateScaleRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    supplierId: row.supplierId,
    model: row.model,
    mode: row.mode,
    currencyCode: row.currencyCode,
    cycleStartedAt: row.cycleStartedAt,
    isActive: row.isActive,
  };
}

// `lockScaleForUpdate` goes through the shared `lockRowForUpdate` primitive
// (`ctx.db.execute`, raw SQL) -- returns the driver's snake_case column
// names, not drizzle's camelCase mapping. This local shape + mapper
// translates back, same pattern as billing's invoice-repository.ts
// RawInvoiceRow.
interface RawScaleRow {
  id: string;
  customer_id: string | null;
  supplier_id: string | null;
  model: ScaleRow["model"];
  mode: ScaleRow["mode"];
  currency_code: string;
  cycle_started_at: Date | null;
  is_active: boolean;
}

function rawScaleToDomain(row: RawScaleRow): RebateScaleRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    supplierId: row.supplier_id,
    model: row.model,
    mode: row.mode,
    currencyCode: row.currency_code,
    cycleStartedAt: row.cycle_started_at,
    isActive: row.is_active,
  };
}

function tierToDomain(row: TierRow): RebateTierRecord {
  return {
    id: row.id,
    scaleId: row.scaleId,
    thresholdQty: Quantity.fromString(row.thresholdQty),
    rebatePerUnitMinor: row.rebatePerUnitMinor,
  };
}

function grantToDomain(row: GrantRow): RebateGrantRecord {
  return {
    id: row.id,
    scaleId: row.scaleId,
    model: row.model,
    periodLabel: row.periodLabel,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    countedQty: Quantity.fromString(row.countedQty),
    tierThresholdQty: Quantity.fromString(row.tierThresholdQty),
    rebatePerUnitMinor: row.rebatePerUnitMinor,
    totalRebateMinor: row.totalRebateMinor,
    currencyCode: row.currencyCode,
    grantedAt: row.grantedAt,
    grantedBy: row.grantedBy,
    trigger: row.trigger,
  };
}

export const rebateRepository: RebateRepository = {
  async insertScale(ctx: TenantSessionContext, input: InsertRebateScaleInput): Promise<RebateScaleRecord> {
    const [row] = await ctx.db
      .insert(rebateScales)
      .values({
        structureId: ctx.actor.structureId,
        customerId: input.customerId,
        supplierId: input.supplierId,
        model: input.model,
        currencyCode: input.currencyCode,
        createdBy: input.createdBy,
      })
      .returning();
    return scaleToDomain(row);
  },

  async findScaleByCustomerId(ctx: TenantSessionContext, customerId: string): Promise<RebateScaleRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(rebateScales)
      .where(and(eq(rebateScales.structureId, ctx.actor.structureId), eq(rebateScales.customerId, customerId)))
      .limit(1);
    return row ? scaleToDomain(row) : null;
  },

  async findScaleBySupplierId(ctx: TenantSessionContext, supplierId: string): Promise<RebateScaleRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(rebateScales)
      .where(and(eq(rebateScales.structureId, ctx.actor.structureId), eq(rebateScales.supplierId, supplierId)))
      .limit(1);
    return row ? scaleToDomain(row) : null;
  },

  async findScaleById(ctx: TenantSessionContext, scaleId: string): Promise<RebateScaleRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(rebateScales)
      .where(and(eq(rebateScales.structureId, ctx.actor.structureId), eq(rebateScales.id, scaleId)))
      .limit(1);
    return row ? scaleToDomain(row) : null;
  },

  async lockScaleForUpdate(ctx: TenantSessionContext, scaleId: string): Promise<RebateScaleRecord | null> {
    const row = await lockRowForUpdate<RawScaleRow>(ctx, "rebate_scales", scaleId);
    return row ? rawScaleToDomain(row) : null;
  },

  async listTiers(ctx: TenantSessionContext, scaleId: string): Promise<RebateTierRecord[]> {
    const rows = await ctx.db
      .select()
      .from(rebateTiers)
      .where(and(eq(rebateTiers.structureId, ctx.actor.structureId), eq(rebateTiers.scaleId, scaleId)))
      .orderBy(asc(rebateTiers.thresholdQty));
    return rows.map(tierToDomain);
  },

  async insertTiers(ctx: TenantSessionContext, scaleId: string, tiers: InsertRebateTierInput[]): Promise<void> {
    if (tiers.length === 0) return;
    await ctx.db.insert(rebateTiers).values(
      tiers.map((t) => ({
        structureId: ctx.actor.structureId,
        scaleId,
        thresholdQty: t.thresholdQty.toDbString(),
        rebatePerUnitMinor: t.rebatePerUnitMinor,
        currencyCode: "XOF",
      }))
    );
  },

  async upsertMonthlyGrant(ctx: TenantSessionContext, input: UpsertMonthlyGrantInput): Promise<RebateGrantRecord> {
    const [row] = await ctx.db
      .insert(rebateGrants)
      .values({
        structureId: ctx.actor.structureId,
        scaleId: input.scaleId,
        model: "monthly",
        periodLabel: input.periodLabel,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        countedQty: input.countedQty.toDbString(),
        tierThresholdQty: input.tierThresholdQty.toDbString(),
        rebatePerUnitMinor: input.rebatePerUnitMinor,
        totalRebateMinor: input.totalRebateMinor,
        currencyCode: input.currencyCode,
        grantedAt: input.grantedAt,
        grantedBy: null,
        trigger: "auto",
      })
      // Matches migration 0016's partial unique index EXACTLY --
      // `rebate_grants_structure_scale_period_label_idx` on
      // (structure_id, scale_id, period_label) WHERE model = 'monthly'.
      // Race-safe: two concurrent "Calculer la ristourne du mois" calls
      // for the same customer+month resolve to ONE row.
      .onConflictDoUpdate({
        target: [rebateGrants.structureId, rebateGrants.scaleId, rebateGrants.periodLabel],
        targetWhere: sql`${rebateGrants.model} = 'monthly'`,
        set: {
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          countedQty: input.countedQty.toDbString(),
          tierThresholdQty: input.tierThresholdQty.toDbString(),
          rebatePerUnitMinor: input.rebatePerUnitMinor,
          totalRebateMinor: input.totalRebateMinor,
          grantedAt: input.grantedAt,
        },
      })
      .returning();
    return grantToDomain(row);
  },

  async insertCyclicGrant(ctx: TenantSessionContext, input: InsertCyclicGrantInput): Promise<RebateGrantRecord> {
    const [row] = await ctx.db
      .insert(rebateGrants)
      .values({
        structureId: ctx.actor.structureId,
        scaleId: input.scaleId,
        model: "cyclic",
        periodLabel: null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        countedQty: input.countedQty.toDbString(),
        tierThresholdQty: input.tierThresholdQty.toDbString(),
        rebatePerUnitMinor: input.rebatePerUnitMinor,
        totalRebateMinor: input.totalRebateMinor,
        currencyCode: input.currencyCode,
        grantedAt: input.grantedAt,
        grantedBy: input.grantedBy,
        trigger: input.trigger,
      })
      .returning();
    return grantToDomain(row);
  },

  async findHighestGrantedTierThresholdSince(
    ctx: TenantSessionContext,
    scaleId: string,
    sinceInclusive: Date
  ): Promise<Quantity | null> {
    const [row] = await ctx.db
      .select({ maxThreshold: sql<string | null>`max(${rebateGrants.tierThresholdQty})` })
      .from(rebateGrants)
      .where(
        and(
          eq(rebateGrants.structureId, ctx.actor.structureId),
          eq(rebateGrants.scaleId, scaleId),
          eq(rebateGrants.model, "cyclic"),
          gte(rebateGrants.grantedAt, sinceInclusive)
        )
      );
    return row?.maxThreshold ? Quantity.fromString(row.maxThreshold) : null;
  },

  async listGrantsByScale(ctx: TenantSessionContext, scaleId: string): Promise<RebateGrantRecord[]> {
    const rows = await ctx.db
      .select()
      .from(rebateGrants)
      .where(and(eq(rebateGrants.structureId, ctx.actor.structureId), eq(rebateGrants.scaleId, scaleId)))
      .orderBy(desc(rebateGrants.grantedAt));
    return rows.map(grantToDomain);
  },

  async listRecentGrants(
    ctx: TenantSessionContext,
    sinceExclusive: Date
  ): Promise<Array<RebateGrantRecord & { customerId: string | null; supplierId: string | null }>> {
    const rows = await ctx.db
      .select({ grant: rebateGrants, customerId: rebateScales.customerId, supplierId: rebateScales.supplierId })
      .from(rebateGrants)
      .innerJoin(
        rebateScales,
        and(eq(rebateGrants.structureId, rebateScales.structureId), eq(rebateGrants.scaleId, rebateScales.id))
      )
      .where(and(eq(rebateGrants.structureId, ctx.actor.structureId), gte(rebateGrants.grantedAt, sinceExclusive)))
      .orderBy(desc(rebateGrants.grantedAt));
    return rows.map((row) => ({
      ...grantToDomain(row.grant),
      customerId: row.customerId,
      supplierId: row.supplierId,
    }));
  },
};
