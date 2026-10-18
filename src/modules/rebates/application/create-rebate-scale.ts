import { z } from "zod";
import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto } from "@/platform/dto/money";
import { Quantity } from "@/modules/inventory";
import { InvalidRebateScaleInputError } from "../domain/errors";
import type { CreateRebateScaleInput, RebateScaleDto } from "./dto";
import type { RebateRepository } from "./ports";
import { toRebateScaleDto } from "./mappers";

const createRebateScaleSchema = z.object({
  customerId: z.uuid().nullable().optional(),
  supplierId: z.uuid().nullable().optional(),
  currencyCode: z.string().length(3),
  tiers: z
    .array(
      z.object({
        thresholdQty: z.string().regex(/^\d+(\.\d{1,4})?$/),
        rebatePerUnitMinor: z.string().regex(/^\d+$/),
      })
    )
    .min(1),
});

// createRebateScale -- exactly one of customerId/supplierId (the DB's own
// `rebate_scales_exactly_one_party_chk`/`rebate_scales_party_model_chk`
// re-verify this too, but rejecting here gives a clean domain error
// instead of a raw constraint violation). `model` is DERIVED from which
// party is set (customer -> monthly, supplier -> cyclic) -- never a
// caller-chosen field, per the fixed product semantics.
export async function createRebateScale(
  ctx: TenantSessionContext,
  rawInput: CreateRebateScaleInput,
  repo: RebateRepository
): Promise<RebateScaleDto> {
  assertCan(ctx.actor, "rebate:write");
  const input = createRebateScaleSchema.parse(rawInput);

  const hasCustomer = Boolean(input.customerId);
  const hasSupplier = Boolean(input.supplierId);
  if (hasCustomer === hasSupplier) {
    throw new InvalidRebateScaleInputError(
      "A rebate scale must have exactly one of customerId/supplierId."
    );
  }

  // insertScale + insertTiers both go through the repository in the SAME
  // transaction (ctx) -- see infrastructure/rebate-repository.ts.
  const scale = await repo.insertScale(ctx, {
    customerId: input.customerId ?? null,
    supplierId: input.supplierId ?? null,
    model: hasCustomer ? "monthly" : "cyclic",
    currencyCode: input.currencyCode,
    createdBy: ctx.actor.userId,
  });

  const tiers = input.tiers.map((t) => ({
    thresholdQty: Quantity.fromString(t.thresholdQty),
    rebatePerUnitMinor: moneyFromDto(t.rebatePerUnitMinor),
  }));
  await repo.insertTiers(ctx, scale.id, tiers);
  const insertedTiers = await repo.listTiers(ctx, scale.id);

  await ctx.audit.append({
    action: "rebate_scale.created",
    targetType: "rebate_scale",
    targetId: scale.id,
    payload: {
      customerId: input.customerId ?? null,
      supplierId: input.supplierId ?? null,
      tierCount: insertedTiers.length,
    },
  });

  return toRebateScaleDto(scale, insertedTiers);
}
