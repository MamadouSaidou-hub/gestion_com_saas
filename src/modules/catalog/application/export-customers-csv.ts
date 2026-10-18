import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { listCustomers } from "./list-customers";
import type { ListCustomersFilter } from "./ports";
import type { CustomerDto } from "./dto";
import type { CustomerRepository } from "./ports";

// exportCustomersCsv -- same convention as sales' exportSalesCsv: gated on
// `report:export`, then delegates UNCHANGED to `listCustomers` so the
// export re-runs the exact filtered/scoped query the clients screen shows.
export async function exportCustomersCsv(
  ctx: TenantSessionContext,
  filter: ListCustomersFilter,
  repo: CustomerRepository
): Promise<CustomerDto[]> {
  assertCan(ctx.actor, "report:export");
  return listCustomers(ctx, filter, repo);
}
