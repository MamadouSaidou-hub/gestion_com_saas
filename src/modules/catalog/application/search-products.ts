import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { ProductRepository } from "./ports";
import type { ProductDto } from "./dto";
import { toProductDto } from "./mappers";

// Thin, named use case over the same repository `list` method (search is
// just a filtered list by name/SKU) -- kept separate from `listProducts` so
// the POS's quick-search call site reads clearly and can diverge later
// (e.g. a dedicated trigram index) without reshaping `listProducts`.
export async function searchProducts(
  ctx: TenantSessionContext,
  query: string,
  repo: ProductRepository
): Promise<ProductDto[]> {
  assertCan(ctx.actor, "product:read");
  const products = await repo.list(ctx, { activeOnly: true, search: query });
  return products.map(toProductDto);
}
