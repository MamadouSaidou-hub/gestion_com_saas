import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { TaxSettingsRepository } from "./ports";

// No `assertCan` here -- this is an internal primitive called by sales'
// confirmSale (already gated on `sale:create`), not an independently
// exposed read a caller could use to bypass a permission check. Reading
// the tenant's VAT rate is not itself sensitive.
export async function getVatRate(
  ctx: TenantSessionContext,
  repo: TaxSettingsRepository
): Promise<string> {
  return repo.getVatRate(ctx);
}
