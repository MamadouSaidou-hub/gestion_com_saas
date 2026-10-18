export class DuplicateSkuError extends Error {
  constructor(sku: string) {
    super(`A product with SKU "${sku}" already exists in this structure.`);
    this.name = "DuplicateSkuError";
  }
}

export class ProductNotFoundError extends Error {
  constructor(productId: string) {
    super(`Product "${productId}" was not found.`);
    this.name = "ProductNotFoundError";
  }
}

export class InvalidProductInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProductInputError";
  }
}

export class CategoryNotFoundError extends Error {
  constructor(categoryId: string) {
    super(`Category "${categoryId}" was not found.`);
    this.name = "CategoryNotFoundError";
  }
}

// Thrown instead of letting the composite FK (product_categories_parent_fk)
// raise a raw constraint violation -- covers both "no such category" and
// "that category belongs to another tenant" without distinguishing the two
// to the caller (the lookup itself is already tenant-scoped).
export class InvalidCategoryParentError extends Error {
  constructor(parentId: string) {
    super(`Parent category "${parentId}" was not found in this structure.`);
    this.name = "InvalidCategoryParentError";
  }
}

export class DuplicateCategoryNameError extends Error {
  constructor(name: string) {
    super(`A category named "${name}" already exists at this level.`);
    this.name = "DuplicateCategoryNameError";
  }
}

// The self-FK cannot catch this -- a category must never become its own
// ancestor via reparenting.
export class CategoryCycleError extends Error {
  constructor(categoryId: string, parentId: string) {
    super(
      `Category "${categoryId}" cannot be moved under "${parentId}": it would create a cycle.`
    );
    this.name = "CategoryCycleError";
  }
}

// --- warehouses ("Magasins", migration 0014) ---

export class DuplicateWarehouseCodeError extends Error {
  constructor(code: string) {
    super(`A store/depot with code "${code}" already exists in this structure.`);
    this.name = "DuplicateWarehouseCodeError";
  }
}

export class WarehouseNotFoundError extends Error {
  constructor(warehouseId: string) {
    super(`Warehouse "${warehouseId}" was not found.`);
    this.name = "WarehouseNotFoundError";
  }
}

export class InvalidWarehouseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWarehouseInputError";
  }
}

// Blocks deletion rather than silently nulling out references -- see
// delete-category.ts for the rationale.
export class CategoryHasDependentsError extends Error {
  // Exposed as real fields (not just baked into the message string) so the
  // Server Action boundary (catalog/api/actions.ts) can map this into a
  // structured UI result -- "8 produits encore rangés ici, les déplacer
  // avant de supprimer" -- without parsing English prose out of an Error.
  public readonly productCount: number;
  public readonly childCount: number;

  constructor(categoryId: string, productCount: number, childCount: number) {
    super(
      `Category "${categoryId}" cannot be deleted: ${productCount} product(s) and ${childCount} sub-categor${
        childCount === 1 ? "y" : "ies"
      } still reference it.`
    );
    this.name = "CategoryHasDependentsError";
    this.productCount = productCount;
    this.childCount = childCount;
  }
}
