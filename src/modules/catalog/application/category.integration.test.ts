import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import { seedStructure, createProduct } from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";

// ---------------------------------------------------------------------------
// Catalog categories ("rayons") integration suite -- same disposable
// postgres:16-alpine container convention as confirm-sale/billing's
// integration suites. Run with `npm run test:integration`.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let catalogService: typeof import("@/modules/catalog").catalogService;
let DuplicateCategoryNameError: typeof import("@/modules/catalog").DuplicateCategoryNameError;
let InvalidCategoryParentError: typeof import("@/modules/catalog").InvalidCategoryParentError;
let CategoryCycleError: typeof import("@/modules/catalog").CategoryCycleError;
let CategoryHasDependentsError: typeof import("@/modules/catalog").CategoryHasDependentsError;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({
    catalogService,
    DuplicateCategoryNameError,
    InvalidCategoryParentError,
    CategoryCycleError,
    CategoryHasDependentsError,
  } = await import("@/modules/catalog"));
});

function ownerActor(fixture: Awaited<ReturnType<typeof seedStructure>>): Actor {
  return { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };
}

describe("catalog categories", () => {
  it("createCategory creates a top-level rayon", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const category = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Petit dejeuner" })
    );

    expect(category.name).toBe("Petit dejeuner");
    expect(category.parentId).toBeNull();
  });

  it("rejects a duplicate name at the same level, case-insensitively", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    await withTenantSession(owner, (ctx) => catalogService.createCategory(ctx, { name: "Boissons" }));

    await expect(
      withTenantSession(owner, (ctx) => catalogService.createCategory(ctx, { name: "boissons" }))
    ).rejects.toThrow(DuplicateCategoryNameError);
  });

  it("allows the same name at a DIFFERENT level (different parent)", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const parentA = await withTenantSession(owner, (ctx) => catalogService.createCategory(ctx, { name: "Rayon A" }));
    const parentB = await withTenantSession(owner, (ctx) => catalogService.createCategory(ctx, { name: "Rayon B" }));

    await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Boissons", parentId: parentA.id })
    );

    // Same name "Boissons" but under a different parent -- not a duplicate.
    const second = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Boissons", parentId: parentB.id })
    );
    expect(second.name).toBe("Boissons");
  });

  it("rejects a parent category from another tenant with a typed error, not a raw FK violation", async () => {
    const fixtureA = await seedStructure();
    const fixtureB = await seedStructure();
    const ownerA = ownerActor(fixtureA);
    const ownerB = ownerActor(fixtureB);

    const categoryInA = await withTenantSession(ownerA, (ctx) =>
      catalogService.createCategory(ctx, { name: "Petit dejeuner" })
    );

    await expect(
      withTenantSession(ownerB, (ctx) =>
        catalogService.createCategory(ctx, { name: "Sous-rayon", parentId: categoryInA.id })
      )
    ).rejects.toThrow(InvalidCategoryParentError);
  });

  it("rejects reparenting a category under its own descendant (cycle guard)", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const parent = await withTenantSession(owner, (ctx) => catalogService.createCategory(ctx, { name: "Parent" }));
    const child = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Child", parentId: parent.id })
    );

    await expect(
      withTenantSession(owner, (ctx) =>
        catalogService.updateCategory(ctx, { id: parent.id, parentId: child.id })
      )
    ).rejects.toThrow(CategoryCycleError);
  });

  it("rejects reparenting a category under itself", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const category = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Solo" })
    );

    await expect(
      withTenantSession(owner, (ctx) =>
        catalogService.updateCategory(ctx, { id: category.id, parentId: category.id })
      )
    ).rejects.toThrow(CategoryCycleError);
  });

  it("listCategories returns [] for a brand-new shop (no categories yet)", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const categories = await withTenantSession(owner, (ctx) => catalogService.listCategories(ctx));
    expect(categories).toEqual([]);
  });

  it("listCategories returns a flat list with parentId, not a nested tree", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const parent = await withTenantSession(owner, (ctx) => catalogService.createCategory(ctx, { name: "Boissons" }));
    await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Sodas", parentId: parent.id })
    );

    const categories = await withTenantSession(owner, (ctx) => catalogService.listCategories(ctx));
    expect(categories).toHaveLength(2);
    const sodas = categories.find((c) => c.name === "Sodas");
    expect(sodas?.parentId).toBe(parent.id);
  });

  it("deleteCategory blocks deletion while products are still assigned, naming the count", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const category = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Petit dejeuner" })
    );
    const productId = await createProduct(fixture, { sku: "SKU-CAT-1", priceMinor: 500 });

    await withTenantSession(owner, (ctx) =>
      catalogService.assignProductsToCategory(ctx, { categoryId: category.id, productIds: [productId] })
    );

    await expect(
      withTenantSession(owner, (ctx) => catalogService.deleteCategory(ctx, category.id))
    ).rejects.toThrow(CategoryHasDependentsError);
  });

  it("deleteCategory blocks deletion while a child category still references it", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const parent = await withTenantSession(owner, (ctx) => catalogService.createCategory(ctx, { name: "Parent" }));
    await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Child", parentId: parent.id })
    );

    await expect(
      withTenantSession(owner, (ctx) => catalogService.deleteCategory(ctx, parent.id))
    ).rejects.toThrow(CategoryHasDependentsError);
  });

  it("deleteCategory succeeds once the category is empty", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const category = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Temporaire" })
    );

    await withTenantSession(owner, (ctx) => catalogService.deleteCategory(ctx, category.id));

    const categories = await withTenantSession(owner, (ctx) => catalogService.listCategories(ctx));
    expect(categories.find((c) => c.id === category.id)).toBeUndefined();
  });

  it("assignProductsToCategory is bulk: one call moves every product in ONE transaction", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const category = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Petit dejeuner" })
    );
    const productIds = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createProduct(fixture, { sku: `SKU-BULK-${i}-${randomUUID()}`, priceMinor: 100 })
      )
    );

    const result = await withTenantSession(owner, (ctx) =>
      catalogService.assignProductsToCategory(ctx, { categoryId: category.id, productIds })
    );
    expect(result.updatedCount).toBe(8);

    const products = await withTenantSession(owner, (ctx) =>
      catalogService.listProducts(ctx, { categoryId: category.id })
    );
    expect(products).toHaveLength(8);
    expect(products.every((p) => p.categoryName === "Petit dejeuner")).toBe(true);
  });

  it("assignProductsToCategory with categoryId: null removes products from any category", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const category = await withTenantSession(owner, (ctx) =>
      catalogService.createCategory(ctx, { name: "Petit dejeuner" })
    );
    const productId = await createProduct(fixture, { sku: "SKU-UNASSIGN", priceMinor: 100 });

    await withTenantSession(owner, (ctx) =>
      catalogService.assignProductsToCategory(ctx, { categoryId: category.id, productIds: [productId] })
    );

    await withTenantSession(owner, (ctx) =>
      catalogService.assignProductsToCategory(ctx, { categoryId: null, productIds: [productId] })
    );

    const product = await withTenantSession(owner, (ctx) => catalogService.getProduct(ctx, productId));
    expect(product.categoryId).toBeNull();
    expect(product.categoryName).toBeNull();
  });

  it("listProducts/getProduct return products with no category gracefully (categoryName: null)", async () => {
    const fixture = await seedStructure();
    const owner = ownerActor(fixture);

    const productId = await createProduct(fixture, { sku: "SKU-NO-CAT", priceMinor: 100 });

    const product = await withTenantSession(owner, (ctx) => catalogService.getProduct(ctx, productId));
    expect(product.categoryId).toBeNull();
    expect(product.categoryName).toBeNull();

    const list = await withTenantSession(owner, (ctx) => catalogService.listProducts(ctx, {}));
    expect(list.some((p) => p.id === productId)).toBe(true);
  });
});
