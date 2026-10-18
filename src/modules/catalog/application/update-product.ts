import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, type MoneyMinorDto } from "@/platform/dto/money";
import { ProductNotFoundError } from "../domain/errors";
import type { ProductRepository } from "./ports";
import type { ProductDto } from "./dto";
import { toProductDto } from "./mappers";

export interface UpdateProductRequest {
  name?: string;
  categoryId?: string | null;
  unitId?: string;
  defaultPriceMinor?: MoneyMinorDto;
  defaultCostMinor?: MoneyMinorDto;
  lowStockThreshold?: string | null;
}

export async function updateProduct(
  ctx: TenantSessionContext,
  productId: string,
  input: UpdateProductRequest,
  repo: ProductRepository
): Promise<ProductDto> {
  // Changing a price is its own permission (`product:price_set`) --
  // checked in addition to the baseline `product:write` whenever a price
  // field is actually present in the request, so a role with `product:write`
  // but not `product:price_set` can still rename a product or change its
  // category without being able to touch its price.
  assertCan(ctx.actor, "product:write");
  if (input.defaultPriceMinor !== undefined) {
    assertCan(ctx.actor, "product:price_set");
  }

  const existing = await repo.findById(ctx, productId);
  if (!existing) {
    throw new ProductNotFoundError(productId);
  }

  const product = await repo.update(ctx, productId, {
    name: input.name,
    categoryId: input.categoryId,
    unitId: input.unitId,
    defaultPriceMinor:
      input.defaultPriceMinor !== undefined ? moneyFromDto(input.defaultPriceMinor) : undefined,
    defaultCostMinor:
      input.defaultCostMinor !== undefined ? moneyFromDto(input.defaultCostMinor) : undefined,
    lowStockThreshold: input.lowStockThreshold,
  });

  await ctx.audit.append({
    action: "product.updated",
    targetType: "product",
    targetId: product.id,
    payload: {
      before: {
        defaultPriceMinor: existing.defaultPriceMinor.toString(),
        defaultCostMinor: existing.defaultCostMinor.toString(),
      },
      after: {
        defaultPriceMinor: product.defaultPriceMinor.toString(),
        defaultCostMinor: product.defaultCostMinor.toString(),
      },
    },
  });

  return toProductDto(product);
}
