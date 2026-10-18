import { moneyToDto } from "@/platform/dto/money";
import type { Product } from "../domain/product";
import type { Category } from "../domain/category";
import type { ProductDto, CategoryDto, WarehouseDto, CustomerDto, SupplierDto } from "./dto";
import type { WarehouseRecord, CustomerRecord, SupplierRecord } from "./ports";

export function toProductDto(product: Product): ProductDto {
  return {
    id: product.id,
    categoryId: product.categoryId,
    categoryName: product.categoryName,
    unitId: product.unitId,
    sku: product.sku,
    name: product.name,
    currencyCode: product.currencyCode,
    defaultPriceMinor: moneyToDto(product.defaultPriceMinor),
    defaultCostMinor: moneyToDto(product.defaultCostMinor),
    lowStockThreshold: product.lowStockThreshold,
    isActive: product.isActive,
    createdAt: product.createdAt.toISOString(),
  };
}

export function toWarehouseDto(warehouse: WarehouseRecord): WarehouseDto {
  return {
    id: warehouse.id,
    code: warehouse.code,
    name: warehouse.name,
    kind: warehouse.kind,
    isDefault: warehouse.isDefault,
    isActive: warehouse.isActive,
    address: warehouse.address,
    phone: warehouse.phone,
    createdAt: warehouse.createdAt.toISOString(),
  };
}

export function toCustomerDto(customer: CustomerRecord): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    isActive: customer.isActive,
    creditLimitMinor: customer.creditLimitMinor !== null ? moneyToDto(customer.creditLimitMinor) : null,
    defaultPaymentTermsDays: customer.defaultPaymentTermsDays,
    address: customer.address,
    notes: customer.notes,
    createdAt: customer.createdAt.toISOString(),
  };
}

export function toSupplierDto(supplier: SupplierRecord): SupplierDto {
  return {
    id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    email: supplier.email,
    createdAt: supplier.createdAt.toISOString(),
  };
}

export function toCategoryDto(category: Category): CategoryDto {
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    createdAt: category.createdAt.toISOString(),
  };
}
