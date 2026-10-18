import { assertCan, scopeFor } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { salesService } from "@/modules/sales";
import type { PaymentRepository } from "./ports";
import type { PaymentDto } from "./dto";
import { toPaymentDto } from "./mappers";

// M3 fix (security-reviewer, Medium) -- see listInvoices's comment: 'own'
// scope filters by the LINKED SALE's `created_by`, not the payment's own
// (a payment can be recorded by an accountant on a sale a cashier made).
//
// L-b fix (security-reviewer follow-up): pushed into SQL via `repo.list`'s
// `saleIds` filter instead of fetch-all-then-filter-in-memory.
export async function listPayments(
  ctx: TenantSessionContext,
  repo: PaymentRepository
): Promise<PaymentDto[]> {
  assertCan(ctx.actor, "payment:read");
  const scope = scopeFor(ctx.actor, "payment:read");

  if (scope === "all") {
    const rows = await repo.list(ctx, {});
    return rows.map(toPaymentDto);
  }

  const ownSaleIds = await salesService.listSaleIdsCreatedBy(ctx, ctx.actor.userId);
  const rows = await repo.list(ctx, { saleIds: ownSaleIds });
  return rows.map(toPaymentDto);
}
