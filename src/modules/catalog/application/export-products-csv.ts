import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { listProducts } from "./list-products";
import type { ProductRepository, ListProductsFilter } from "./ports";
import type { ProductDto } from "./dto";

// Same convention as sales'/inventory's/stock-transfers' CSV export wrappers.
export async function exportProductsCsv(
  ctx: TenantSessionContext,
  filter: ListProductsFilter,
  repo: ProductRepository
): Promise<ProductDto[]> {
  assertCan(ctx.actor, "report:export");
  return listProducts(ctx, filter, repo);
}
