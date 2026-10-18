import { assertCan, scopeFor } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { salesService } from "@/modules/sales";
import type { InvoiceRepository } from "./ports";
import type { InvoiceDto, InvoiceStatus } from "./dto";
import { toInvoiceDto } from "./mappers";

// M3 fix (security-reviewer, Medium): 'own' scope now filters by the
// LINKED SALE's `created_by`, not the invoice's own `created_by` -- an
// invoice's creator is typically the accountant who issued it, not the
// cashier who sold it, so filtering by the document's own `created_by`
// protected nothing useful for a cashier (they'd never see their own
// sale's invoice). A standalone invoice with no linked sale is excluded
// from 'own' scope entirely (there is no "own sale" to match against).
//
// L-b fix (security-reviewer follow-up): the 'own' filter is now pushed
// into SQL (`sale_id IN (...)`) via `repo.list`'s `saleIds` filter,
// instead of fetching every tenant invoice and filtering in application
// memory.
export async function listInvoices(
  ctx: TenantSessionContext,
  filter: { status?: InvoiceStatus },
  repo: InvoiceRepository
): Promise<InvoiceDto[]> {
  assertCan(ctx.actor, "invoice:read");
  const scope = scopeFor(ctx.actor, "invoice:read");

  if (scope === "all") {
    const rows = await repo.list(ctx, { status: filter.status });
    return rows.map(toInvoiceDto);
  }

  const ownSaleIds = await salesService.listSaleIdsCreatedBy(ctx, ctx.actor.userId);
  const rows = await repo.list(ctx, { status: filter.status, saleIds: ownSaleIds });
  return rows.map(toInvoiceDto);
}
