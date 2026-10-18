"use server";

import { z } from "zod";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { ForbiddenError, UnauthenticatedError } from "@/platform/errors";
import {
  catalogService,
  CategoryHasDependentsError,
  CategoryNotFoundError,
  CategoryCycleError,
  DuplicateCategoryNameError,
  InvalidCategoryParentError,
} from "../index";
import type { CategoryDto, AssignProductsToCategoryResult } from "../index";

// ---------------------------------------------------------------------------
// Thin Server Actions for the catalog module -- NOT wired to any screen yet
// (this phase's scope is catalog+inventory use cases only; `/produits` goes
// off mock data in a later step). Each one follows the same five-step chain
// documented in docs/platform.md: getSession -> resolveActor -> (assertCan
// happens INSIDE the use case, not here) -> withTenantSession -> use case.
// ---------------------------------------------------------------------------

const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  unitId: z.uuid(),
  categoryId: z.uuid().nullable().optional(),
  currencyCode: z.string().length(3),
  defaultPriceMinor: z.string().regex(/^-?\d+$/),
  defaultCostMinor: z.string().regex(/^-?\d+$/),
  lowStockThreshold: z.string().nullable().optional(),
});

const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  categoryId: z.uuid().nullable().optional(),
  unitId: z.uuid().optional(),
  defaultPriceMinor: z.string().regex(/^-?\d+$/).optional(),
  defaultCostMinor: z.string().regex(/^-?\d+$/).optional(),
  lowStockThreshold: z.string().nullable().optional(),
});

export async function listProductsAction(structureId: string, search?: string) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  return withTenantSession(actor, (ctx) =>
    catalogService.listProducts(ctx, { activeOnly: true, search })
  );
}

export async function getProductAction(structureId: string, productId: string) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  return withTenantSession(actor, (ctx) => catalogService.getProduct(ctx, productId));
}

export async function createProductAction(structureId: string, formData: FormData) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  const parsed = createProductSchema.parse({
    sku: formData.get("sku"),
    name: formData.get("name"),
    unitId: formData.get("unitId"),
    categoryId: formData.get("categoryId") || null,
    currencyCode: formData.get("currencyCode"),
    defaultPriceMinor: formData.get("defaultPriceMinor"),
    defaultCostMinor: formData.get("defaultCostMinor"),
    lowStockThreshold: formData.get("lowStockThreshold") || null,
  });
  return withTenantSession(actor, (ctx) => catalogService.createProduct(ctx, parsed));
}

export async function updateProductAction(
  structureId: string,
  productId: string,
  formData: FormData
) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  const raw: Record<string, unknown> = {};
  for (const key of [
    "name",
    "categoryId",
    "unitId",
    "defaultPriceMinor",
    "defaultCostMinor",
    "lowStockThreshold",
  ]) {
    const value = formData.get(key);
    if (value !== null) {
      raw[key] = value;
    }
  }
  const parsed = updateProductSchema.parse(raw);
  return withTenantSession(actor, (ctx) => catalogService.updateProduct(ctx, productId, parsed));
}

export async function archiveProductAction(structureId: string, productId: string) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  return withTenantSession(actor, (ctx) => catalogService.archiveProduct(ctx, productId));
}

// ---------------------------------------------------------------------------
// Categories ("rayons") -- same five-step chain, same `assertCan`-inside-
// the-use-case discipline.
// ---------------------------------------------------------------------------

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().nullable().optional(),
});

const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  parentId: z.uuid().nullable().optional(),
});

const assignProductsToCategorySchema = z.object({
  categoryId: z.uuid().nullable(),
  productIds: z.array(z.uuid()).min(1),
});

export async function listCategoriesAction(structureId: string) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  return withTenantSession(actor, (ctx) => catalogService.listCategories(ctx));
}

// ---------------------------------------------------------------------------
// Category mutations return a structured result instead of throwing --
// mirrors `confirmSaleAction`'s convention (sales/api/actions.ts). Next.js
// strips thrown Error subclasses down to a generic digest in production, so
// the UI would otherwise lose exactly the detail it needs (e.g. "8 produits
// encore rangés ici") to show a helpful message instead of a raw error.
// ---------------------------------------------------------------------------

export type CategoryActionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "DUPLICATE_NAME"
  | "INVALID_PARENT"
  | "CYCLE"
  | "HAS_DEPENDENTS"
  | "UNKNOWN";

export type CategoryActionResult =
  | { ok: true; category: CategoryDto }
  | { ok: false; code: CategoryActionErrorCode; message: string };

export type DeleteCategoryActionResult =
  | { ok: true }
  | { ok: false; code: "HAS_DEPENDENTS"; productCount: number; childCount: number }
  | { ok: false; code: Exclude<CategoryActionErrorCode, "HAS_DEPENDENTS">; message: string };

export type AssignCategoryActionResult =
  | { ok: true; result: AssignProductsToCategoryResult }
  | { ok: false; code: CategoryActionErrorCode; message: string };

export async function createCategoryAction(
  structureId: string,
  formData: FormData
): Promise<CategoryActionResult> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const parsed = createCategorySchema.parse({
      name: formData.get("name"),
      parentId: formData.get("parentId") || null,
    });
    const category = await withTenantSession(actor, (ctx) =>
      catalogService.createCategory(ctx, parsed)
    );
    return { ok: true, category };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: "FORBIDDEN", message: "Action non autorisée pour votre rôle." };
    }
    if (err instanceof DuplicateCategoryNameError) {
      return { ok: false, code: "DUPLICATE_NAME", message: "Un rayon porte déjà ce nom." };
    }
    if (err instanceof InvalidCategoryParentError) {
      return { ok: false, code: "INVALID_PARENT", message: "Rayon parent introuvable." };
    }
    return { ok: false, code: "UNKNOWN", message: "Impossible de créer ce rayon." };
  }
}

export async function updateCategoryAction(
  structureId: string,
  categoryId: string,
  formData: FormData
): Promise<CategoryActionResult> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const raw: Record<string, unknown> = {};
    for (const key of ["name", "parentId"]) {
      const value = formData.get(key);
      if (value !== null) {
        raw[key] = value;
      }
    }
    const parsed = updateCategorySchema.parse(raw);
    const category = await withTenantSession(actor, (ctx) =>
      catalogService.updateCategory(ctx, { id: categoryId, ...parsed })
    );
    return { ok: true, category };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: "FORBIDDEN", message: "Action non autorisée pour votre rôle." };
    }
    if (err instanceof CategoryNotFoundError) {
      return { ok: false, code: "NOT_FOUND", message: "Ce rayon n'existe plus." };
    }
    if (err instanceof DuplicateCategoryNameError) {
      return { ok: false, code: "DUPLICATE_NAME", message: "Un rayon porte déjà ce nom." };
    }
    if (err instanceof InvalidCategoryParentError) {
      return { ok: false, code: "INVALID_PARENT", message: "Rayon parent introuvable." };
    }
    if (err instanceof CategoryCycleError) {
      return { ok: false, code: "CYCLE", message: "Ce déplacement créerait une boucle de rayons." };
    }
    return { ok: false, code: "UNKNOWN", message: "Impossible de modifier ce rayon." };
  }
}

export async function deleteCategoryAction(
  structureId: string,
  categoryId: string
): Promise<DeleteCategoryActionResult> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    await withTenantSession(actor, (ctx) => catalogService.deleteCategory(ctx, categoryId));
    return { ok: true };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: "FORBIDDEN", message: "Action non autorisée pour votre rôle." };
    }
    if (err instanceof CategoryNotFoundError) {
      return { ok: false, code: "NOT_FOUND", message: "Ce rayon n'existe plus." };
    }
    if (err instanceof CategoryHasDependentsError) {
      // Pulled straight off the error's own fields rather than parsed out
      // of its message -- see domain/errors.ts, this is exactly what the
      // UI needs to offer "déplacer les produits avant de supprimer".
      return {
        ok: false,
        code: "HAS_DEPENDENTS",
        productCount: err.productCount,
        childCount: err.childCount,
      };
    }
    return { ok: false, code: "UNKNOWN", message: "Impossible de supprimer ce rayon." };
  }
}

export async function assignProductsToCategoryAction(
  structureId: string,
  input: { categoryId: string | null; productIds: string[] }
): Promise<AssignCategoryActionResult> {
  try {
    const session = await getSession();
    if (!session) {
      return { ok: false, code: "UNAUTHENTICATED", message: "Session expirée." };
    }
    const actor = await resolveActor(session, structureId);
    const parsed = assignProductsToCategorySchema.parse(input);
    const result = await withTenantSession(actor, (ctx) =>
      catalogService.assignProductsToCategory(ctx, parsed)
    );
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: "FORBIDDEN", message: "Action non autorisée pour votre rôle." };
    }
    if (err instanceof CategoryNotFoundError) {
      return { ok: false, code: "NOT_FOUND", message: "Ce rayon n'existe plus." };
    }
    return { ok: false, code: "UNKNOWN", message: "Impossible de déplacer ces produits." };
  }
}
