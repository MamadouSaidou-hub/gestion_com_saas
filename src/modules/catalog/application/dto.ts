import type { MoneyMinorDto } from "@/platform/dto/money";

// Transport-safe product shape -- every bigint money column converted to a
// string (see @/platform/dto/money). This is what crosses the RSC/Server
// Action boundary; never pass a raw `Product` (domain, bigint) to a client
// component.
export interface ProductDto {
  id: string;
  categoryId: string | null;
  // Joined at read time -- see `Product.categoryName` in the domain entity.
  // Lets the POS group by rayon directly off `listProducts`/`searchProducts`
  // without a second lookup per product.
  categoryName: string | null;
  unitId: string;
  sku: string;
  name: string;
  currencyCode: string;
  defaultPriceMinor: MoneyMinorDto;
  defaultCostMinor: MoneyMinorDto;
  lowStockThreshold: string | null;
  isActive: boolean;
  createdAt: string; // ISO 8601
}

// Transport-safe category ("rayon") shape -- flat, with `parentId` so the
// designer/UI builds the tree client-side (nesting is possible per the
// schema's self-FK, but v1 usage is expected to be shallow, e.g. "Petit
// dejeuner" with no further children). No money fields, nothing to convert.
export interface CategoryDto {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string; // ISO 8601
}
