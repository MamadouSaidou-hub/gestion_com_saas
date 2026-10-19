import { z } from "zod";
import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto } from "@/platform/dto/money";
import { Quantity } from "@/modules/inventory";
import { RebateScaleNotFoundError } from "../domain/errors";
import type { RebateTierInput, RebateScaleDto } from "./dto";
import type { RebateRepository } from "./ports";
import { toRebateScaleDto } from "./mappers";

const updateRebateScaleTiersSchema = z.object({
  scaleId: z.uuid(),
  tiers: z
    .array(
      z.object({
        thresholdQty: z.string().regex(/^\d+(\.\d{1,4})?$/),
        rebatePerUnitMinor: z.string().regex(/^\d+$/),
      })
    )
    .min(1),
});

// updateRebateScaleTiers -- the tier-configuration screen's "edit/remove
// thresholds" path for an ALREADY-EXISTING scale. Always a full replace
// (delete + re-insert the whole tier list in the SAME transaction, see
// RebateRepository.replaceTiers' header comment) -- there is exactly one
// write path for a scale's tiers under the hood (createRebateScale inserts
// the first set, this replaces it later), so the UI cannot drift into a
// second, subtly different way to configure a rebate.
export async function updateRebateScaleTiers(
  ctx: TenantSessionContext,
  scaleId: string,
  rawTiers: RebateTierInput[],
  repo: RebateRepository
): Promise<RebateScaleDto> {
  assertCan(ctx.actor, "rebate:write");
  const input = updateRebateScaleTiersSchema.parse({ scaleId, tiers: rawTiers });

  const scale = await repo.findScaleById(ctx, input.scaleId);
  if (!scale) {
    throw new RebateScaleNotFoundError();
  }

  const tiers = input.tiers.map((t) => ({
    thresholdQty: Quantity.fromString(t.thresholdQty),
    rebatePerUnitMinor: moneyFromDto(t.rebatePerUnitMinor),
  }));
  await repo.replaceTiers(ctx, scale.id, tiers);
  const updatedTiers = await repo.listTiers(ctx, scale.id);

  await ctx.audit.append({
    action: "rebate_scale.tiers_updated",
    targetType: "rebate_scale",
    targetId: scale.id,
    payload: {
      customerId: scale.customerId,
      supplierId: scale.supplierId,
      tierCount: updatedTiers.length,
    },
  });

  return toRebateScaleDto(scale, updatedTiers);
}
