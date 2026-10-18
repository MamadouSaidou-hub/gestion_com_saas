import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { ProductNotFoundError } from "../domain/errors";
import type { ProductRepository } from "./ports";
import type { ProductDto } from "./dto";
import { toProductDto } from "./mappers";

export async function getProduct(
  ctx: TenantSessionContext,
  productId: string,
  repo: ProductRepository
): Promise<ProductDto> {
  assertCan(ctx.actor, "product:read");
  const product = await repo.findById(ctx, productId);
  if (!product) {
    throw new ProductNotFoundError(productId);
  }
  return toProductDto(product);
}
