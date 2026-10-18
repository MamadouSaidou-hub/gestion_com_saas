import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { CustomerRepository, ListCustomersFilter } from "./ports";
import type { CustomerDto } from "./dto";
import { toCustomerDto } from "./mappers";

// listCustomers -- the clients screen's read use case. Store-scoping ("a
// gerant sees customers who have activity in their store") is NOT computed
// here (catalog cannot depend on sales -- see sales/index.ts's comment on
// why that would be a module cycle): the caller resolves the restricting
// id set via `salesService.listCustomerIdsForStore` and passes it in as
// `filter.ids`. An unscoped actor (owner, or any role with no pinned
// store) passes `filter.ids: undefined` and sees every customer.
export async function listCustomers(
  ctx: TenantSessionContext,
  filter: ListCustomersFilter,
  repo: CustomerRepository
): Promise<CustomerDto[]> {
  assertCan(ctx.actor, "customer:read");
  const rows = await repo.list(ctx, filter);
  return rows.map(toCustomerDto);
}
