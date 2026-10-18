import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, type MoneyMinorDto } from "@/platform/dto/money";
import { DuplicateSkuError, InvalidProductInputError } from "../domain/errors";
import type { ProductRepository } from "./ports";
import type { ProductDto } from "./dto";
import { toProductDto } from "./mappers";

export interface CreateProductRequest {
  sku: string;
  name: string;
  unitId: string;
  categoryId?: string | null;
  currencyCode: string;
  defaultPriceMinor: MoneyMinorDto;
  defaultCostMinor: MoneyMinorDto;
  lowStockThreshold?: string | null;
}

export async function createProduct(
  ctx: TenantSessionContext,
  input: CreateProductRequest,
  repo: ProductRepository
): Promise<ProductDto> {
  assertCan(ctx.actor, "product:write");

  const sku = input.sku.trim();
  const name = input.name.trim();
  if (sku.length === 0 || name.length === 0) {
    throw new InvalidProductInputError("SKU and name are required.");
  }

  const existing = await repo.findBySku(ctx, sku);
  if (existing) {
    throw new DuplicateSkuError(sku);
  }

  const product = await repo.insert(ctx, {
    sku,
    name,
    unitId: input.unitId,
    categoryId: input.categoryId ?? null,
    currencyCode: input.currencyCode,
    defaultPriceMinor: moneyFromDto(input.defaultPriceMinor),
    defaultCostMinor: moneyFromDto(input.defaultCostMinor),
    lowStockThreshold: input.lowStockThreshold ?? null,
  });

  // ids + amounts only -- no PII.
  await ctx.audit.append({
    action: "product.created",
    targetType: "product",
    targetId: product.id,
    payload: {
      sku: product.sku,
      defaultPriceMinor: input.defaultPriceMinor,
      defaultCostMinor: input.defaultCostMinor,
    },
  });

  return toProductDto(product);
}
