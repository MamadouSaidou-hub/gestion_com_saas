import { eq } from "drizzle-orm";
import { taxSettings } from "@/db/schema/billing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { TaxSettingsRepository } from "../application/ports";

export const taxSettingsRepository: TaxSettingsRepository = {
  async getVatRate(ctx: TenantSessionContext): Promise<string> {
    const [row] = await ctx.db
      .select({ vatRate: taxSettings.vatRate })
      .from(taxSettings)
      .where(eq(taxSettings.structureId, ctx.actor.structureId))
      .limit(1);
    return row?.vatRate ?? "0";
  },

  async getInvoicePrefix(ctx: TenantSessionContext): Promise<string | null> {
    const [row] = await ctx.db
      .select({ invoicePrefix: taxSettings.invoicePrefix })
      .from(taxSettings)
      .where(eq(taxSettings.structureId, ctx.actor.structureId))
      .limit(1);
    return row?.invoicePrefix ?? null;
  },
};
