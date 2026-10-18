export { listProducts } from "./list-products";
export { searchProducts } from "./search-products";
export { getProduct } from "./get-product";
export { createProduct, type CreateProductRequest } from "./create-product";
export { updateProduct, type UpdateProductRequest } from "./update-product";
export { archiveProduct } from "./archive-product";
export { findOrCreateCustomerByName } from "./find-or-create-customer";
export { createCategory, type CreateCategoryRequest } from "./create-category";
export { updateCategory, type UpdateCategoryRequest } from "./update-category";
export { deleteCategory } from "./delete-category";
export { listCategories } from "./list-categories";
export { listWarehouses } from "./list-warehouses";
export { createWarehouse, type CreateWarehouseRequest } from "./create-warehouse";
export { archiveWarehouse } from "./archive-warehouse";
export {
  assignProductsToCategory,
  type AssignProductsToCategoryRequest,
  type AssignProductsToCategoryResult,
} from "./assign-products-to-category";
export type { ProductDto, CategoryDto, WarehouseDto } from "./dto";
export type {
  ProductRepository,
  ListProductsFilter,
  CustomerRepository,
  CustomerRecord,
  CategoryRepository,
  CategorySiblingRecord,
  WarehouseRepository,
  WarehouseRecord,
  ListWarehousesFilter,
  WarehouseKind,
} from "./ports";
