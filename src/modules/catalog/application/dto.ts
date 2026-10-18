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

// Transport-safe warehouse ("Magasin" -- store or depot) shape, migration
// 0014. `kind` drives the "store selector only offers stores" product rule
// -- the stock/transfer screens accept depots too, so this DTO carries
// `kind` rather than the UI assuming every warehouse is a sellable store.
export interface WarehouseDto {
  id: string;
  code: string;
  name: string;
  kind: "store" | "depot";
  isDefault: boolean;
  isActive: boolean;
  address: string | null;
  phone: string | null;
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

// Transport-safe customer ("Client") shape -- migration 0016's clients
// screen columns. `phone` is E.164, clear text, tenant-scoped (D7) -- never
// put this DTO's `phone`/`address` into an audit payload (the PII guard
// throws on those key names by design).
export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  creditLimitMinor: MoneyMinorDto | null;
  defaultPaymentTermsDays: number | null;
  address: string | null;
  notes: string | null;
  createdAt: string; // ISO 8601
}
