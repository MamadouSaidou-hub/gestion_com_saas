import { z } from "zod";
import { assertCan, scopeFor, resolveStoreScope } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { toSaleSummaryDto } from "./mappers";
import type { ListSalesInput, SaleSummaryDto } from "./dto";
import type { SalesRepository } from "./ports";

// ---------------------------------------------------------------------------
// listSales -- the sales history screen's read use case, and the exact query
// the CSV export re-runs (never a separate "export everything" query). Both
// scoping axes are enforced here, independently, exactly as the task asked:
//  - `scope` ('own' | 'all') from scopeFor(actor, 'sale:read') -- a cashier
//    without `sale:read_all` only ever sees sales THEY created.
//  - `storeScope` from resolveStoreScope(actor, requested warehouse) -- a
//    gerant only ever sees their own store's sales, regardless of what a
//    forged/stale `warehouseId` filter asks for.
// ---------------------------------------------------------------------------

const listSalesSchema = z.object({
  warehouseId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  paymentStatus: z.enum(["unpaid", "partial", "paid"]).optional(),
  ticketNumber: z.string().regex(/^\d+$/).optional(),
  // Plain date (yyyy-mm-dd, from an <input type="date">) -- never a bare
  // datetime string with an implicit/ambiguous timezone.
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function listSales(
  ctx: TenantSessionContext,
  rawInput: ListSalesInput,
  repo: SalesRepository
): Promise<SaleSummaryDto[]> {
  assertCan(ctx.actor, "sale:read");
  const input = listSalesSchema.parse(rawInput);
  const scope = scopeFor(ctx.actor, "sale:read");
  const storeScope = resolveStoreScope(ctx.actor, input.warehouseId ?? null);

  const rows = await repo.list(ctx, {
    createdBy: scope === "own" ? ctx.actor.userId : undefined,
    storeScope,
    warehouseId: input.warehouseId,
    customerId: input.customerId,
    paymentStatus: input.paymentStatus,
    ticketNumber: input.ticketNumber ? BigInt(input.ticketNumber) : undefined,
    // UTC day boundaries -- same "accounting day = UTC day" convention as
    // analytics/domain/period.ts (both Senegal and Guinea sit at UTC+0).
    periodFrom: input.periodFrom ? new Date(`${input.periodFrom}T00:00:00.000Z`) : undefined,
    periodTo: input.periodTo ? new Date(`${input.periodTo}T23:59:59.999Z`) : undefined,
    status: "confirmed",
  });

  return rows.map(toSaleSummaryDto);
}
