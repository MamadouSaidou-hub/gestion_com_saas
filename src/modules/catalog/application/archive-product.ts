import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { ProductNotFoundError } from "../domain/errors";
import type { ProductRepository } from "./ports";
import type { ProductDto } from "./dto";
import { toProductDto } from "./mappers";

// Never a hard delete -- a product can be referenced by years of
// stock_movements/sale_lines history; archiving only flips `is_active` so
// it stops showing up in the POS/catalog picker while every historical
// reference stays intact.
export async function archiveProduct(
  ctx: TenantSessionContext,
  productId: string,
  repo: ProductRepository
): Promise<ProductDto> {
  assertCan(ctx.actor, "product:archive");

  const existing = await repo.findById(ctx, productId);
  if (!existing) {
    throw new ProductNotFoundError(productId);
  }

  const product = await repo.setActive(ctx, productId, false);

  await ctx.audit.append({
    action: "product.archived",
    targetType: "product",
    targetId: product.id,
    payload: {},
  });

  return toProductDto(product);
}
