import { eq } from "drizzle-orm";
import { structureSettings } from "@/db/schema/tenancy";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// H4 fix (security-reviewer, High): `structure_settings.sod_threshold_minor`
// / `max_discount_pct` were read by NO code -- this is the ctx-based read
// primitive sales' confirmSale (discount path) and billing's voidPayment
// now call. Lives in tenancy (same module that owns permissions.ts/
// resolveActor) since this is a cross-cutting, structure-level policy
// setting, not owned by any single business module. NULL
// `sodThresholdMinor` = separation of duties disabled (the approved
// default) -- callers must treat that as "the rule never triggers", not
// as a 0 threshold.
// ---------------------------------------------------------------------------

export interface StructureSettings {
  sodThresholdMinor: bigint | null;
  maxDiscountPct: string | null;
}

export async function getStructureSettings(ctx: TenantSessionContext): Promise<StructureSettings> {
  const [row] = await ctx.db
    .select({
      sodThresholdMinor: structureSettings.sodThresholdMinor,
      maxDiscountPct: structureSettings.maxDiscountPct,
    })
    .from(structureSettings)
    .where(eq(structureSettings.structureId, ctx.actor.structureId))
    .limit(1);
  return {
    sodThresholdMinor: row?.sodThresholdMinor ?? null,
    maxDiscountPct: row?.maxDiscountPct ?? null,
  };
}
