import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { evaluateAndGrantSupplierTier, type CheckSupplierTierInput } from "./check-and-grant-supplier-tier";
import type { RebateGrantDto } from "./dto";
import type { RebateRepository } from "./ports";

// verifyRebateTier -- "vérifier le palier", the manual trigger a user runs
// from the supplier's "Barème" screen. Runs the SAME use case as the
// automatic in-delivery trigger (evaluateAndGrantSupplierTier) -- a no-op
// (no write, no audit) when no NEW threshold has been met since the last
// grant, exactly like the brief requires.
export async function verifyRebateTier(
  ctx: TenantSessionContext,
  input: CheckSupplierTierInput,
  repo: RebateRepository
): Promise<RebateGrantDto | null> {
  assertCan(ctx.actor, "rebate:grant");
  return evaluateAndGrantSupplierTier(ctx, input, repo, "manual", ctx.actor.userId);
}
