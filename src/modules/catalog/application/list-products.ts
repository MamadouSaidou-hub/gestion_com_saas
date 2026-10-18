import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { ProductRepository, ListProductsFilter } from "./ports";
import type { ProductDto } from "./dto";
import { toProductDto } from "./mappers";

export async function listProducts(
  ctx: TenantSessionContext,
  filter: ListProductsFilter,
  repo: ProductRepository
): Promise<ProductDto[]> {
  assertCan(ctx.actor, "product:read");
  const products = await repo.list(ctx, filter);
  return products.map(toProductDto);
}
