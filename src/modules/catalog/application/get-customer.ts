import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { CustomerNotFoundError } from "../domain/errors";
import type { CustomerRepository } from "./ports";
import type { CustomerDto } from "./dto";
import { toCustomerDto } from "./mappers";

// getCustomer -- a gerant's store-scope check is NOT done here (catalog
// has no notion of "store activity", see list-customers.ts's comment) --
// the customer detail PAGE is responsible for checking that a store-scoped
// actor is only shown a customer that is also returned by
// `salesService.listCustomerIdsForStore` for their own store, and must
// treat a mismatch as `notFound()`, same convention as sale documents.
export async function getCustomer(
  ctx: TenantSessionContext,
  customerId: string,
  repo: CustomerRepository
): Promise<CustomerDto> {
  assertCan(ctx.actor, "customer:read");
  const row = await repo.findById(ctx, customerId);
  if (!row) {
    throw new CustomerNotFoundError(customerId);
  }
  return toCustomerDto(row);
}
