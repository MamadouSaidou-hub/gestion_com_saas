import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { productRepository } from "./infrastructure/product-repository";
import { customerRepository } from "./infrastructure/customer-repository";
import { categoryRepository } from "./infrastructure/category-repository";
import { warehouseRepository } from "./infrastructure/warehouse-repository";
import * as useCases from "./application";
import type {
  ListProductsFilter,
  CreateProductRequest,
  UpdateProductRequest,
  CreateCategoryRequest,
  UpdateCategoryRequest,
  AssignProductsToCategoryRequest,
  ListWarehousesFilter,
  CreateWarehouseRequest,
  ListCustomersFilter,
  CreateCustomerRequest,
  UpdateCustomerRequest,
} from "./application";

// ---------------------------------------------------------------------------
// catalog/index.ts -- the ONLY surface another module is allowed to import
// from. Composition root: wires the concrete (drizzle) repository into the
// pure application use cases. Other modules call `catalogService.xxx(ctx,
// ...)`, passing the `TenantSessionContext` their own top-level use case
// already opened -- never `@/modules/catalog/domain/*`,
// `@/modules/catalog/infrastructure/*`, or `@/db/schema/catalog` directly
// (enforced by the ESLint cross-module boundary rule).
// ---------------------------------------------------------------------------

export const catalogService = {
  listProducts: (ctx: TenantSessionContext, filter: ListProductsFilter) =>
    useCases.listProducts(ctx, filter, productRepository),
  exportProductsCsv: (ctx: TenantSessionContext, filter: ListProductsFilter) =>
    useCases.exportProductsCsv(ctx, filter, productRepository),
  searchProducts: (ctx: TenantSessionContext, query: string) =>
    useCases.searchProducts(ctx, query, productRepository),
  getProduct: (ctx: TenantSessionContext, productId: string) =>
    useCases.getProduct(ctx, productId, productRepository),
  createProduct: (ctx: TenantSessionContext, input: CreateProductRequest) =>
    useCases.createProduct(ctx, input, productRepository),
  updateProduct: (ctx: TenantSessionContext, productId: string, input: UpdateProductRequest) =>
    useCases.updateProduct(ctx, productId, input, productRepository),
  archiveProduct: (ctx: TenantSessionContext, productId: string) =>
    useCases.archiveProduct(ctx, productId, productRepository),
  findOrCreateCustomerByName: (ctx: TenantSessionContext, name: string) =>
    useCases.findOrCreateCustomerByName(ctx, name, customerRepository),
  listCustomers: (ctx: TenantSessionContext, filter: ListCustomersFilter = {}) =>
    useCases.listCustomers(ctx, filter, customerRepository),
  exportCustomersCsv: (ctx: TenantSessionContext, filter: ListCustomersFilter = {}) =>
    useCases.exportCustomersCsv(ctx, filter, customerRepository),
  getCustomer: (ctx: TenantSessionContext, customerId: string) =>
    useCases.getCustomer(ctx, customerId, customerRepository),
  createCustomer: (ctx: TenantSessionContext, input: CreateCustomerRequest) =>
    useCases.createCustomer(ctx, input, customerRepository),
  updateCustomer: (ctx: TenantSessionContext, customerId: string, input: UpdateCustomerRequest) =>
    useCases.updateCustomer(ctx, customerId, input, customerRepository),
  // --- categories ("rayons") ---
  createCategory: (ctx: TenantSessionContext, input: CreateCategoryRequest) =>
    useCases.createCategory(ctx, input, categoryRepository),
  updateCategory: (ctx: TenantSessionContext, input: UpdateCategoryRequest) =>
    useCases.updateCategory(ctx, input, categoryRepository),
  deleteCategory: (ctx: TenantSessionContext, categoryId: string) =>
    useCases.deleteCategory(ctx, categoryId, categoryRepository),
  listCategories: (ctx: TenantSessionContext) => useCases.listCategories(ctx, categoryRepository),
  assignProductsToCategory: (ctx: TenantSessionContext, input: AssignProductsToCategoryRequest) =>
    useCases.assignProductsToCategory(ctx, input, productRepository, categoryRepository),
  // --- warehouses ("Magasins") ---
  listWarehouses: (ctx: TenantSessionContext, filter: ListWarehousesFilter = {}) =>
    useCases.listWarehouses(ctx, filter, warehouseRepository),
  createWarehouse: (ctx: TenantSessionContext, input: CreateWarehouseRequest) =>
    useCases.createWarehouse(ctx, input, warehouseRepository),
  archiveWarehouse: (ctx: TenantSessionContext, warehouseId: string) =>
    useCases.archiveWarehouse(ctx, warehouseId, warehouseRepository),
};

export type {
  ProductDto,
  CategoryDto,
  WarehouseDto,
  CustomerDto,
  ListProductsFilter,
  CreateProductRequest,
  UpdateProductRequest,
  CreateCategoryRequest,
  UpdateCategoryRequest,
  AssignProductsToCategoryRequest,
  AssignProductsToCategoryResult,
  ListWarehousesFilter,
  CreateWarehouseRequest,
  ListCustomersFilter,
  CreateCustomerRequest,
  UpdateCustomerRequest,
} from "./application";
export {
  DuplicateSkuError,
  ProductNotFoundError,
  InvalidProductInputError,
  CategoryNotFoundError,
  InvalidCategoryParentError,
  DuplicateCategoryNameError,
  CategoryCycleError,
  CategoryHasDependentsError,
  DuplicateWarehouseCodeError,
  WarehouseNotFoundError,
  InvalidWarehouseInputError,
  CustomerNotFoundError,
  InvalidCustomerInputError,
} from "./domain/errors";
