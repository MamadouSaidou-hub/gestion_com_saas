import { eq, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { catalogService } from "@/modules/catalog";
import { inventoryService } from "@/modules/inventory";
import {
  createProductAction,
  createCategoryAction,
  updateCategoryAction,
  deleteCategoryAction,
  assignProductsToCategoryAction,
} from "@/modules/catalog/api/actions";
import { receiveStockAction } from "@/modules/inventory/api/actions";
import { ProductListClient } from "./product-list-client";

// Gated, structure-scoped page: /s/[structureId]/produits -- now wired to
// the REAL catalog + inventory modules (Phase 1 step 6). Same
// resolveActor() re-verification pattern as every other screen.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function ProduitsPage({
  params,
}: {
  params: Promise<{ structureId: string }>;
}) {
  const { structureId } = await params;

  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  let actor;
  try {
    actor = await resolveActor(session, structureId);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      redirect("/login");
    }
    if (err instanceof NotAMemberError) {
      notFound();
    }
    throw err;
  }

  const data = await withTenantSession(actor, async (ctx) => {
    const [structureRow] = await ctx.db
      .select({ name: structures.name, countryCode: structures.countryCode, currencyCode: structures.currencyCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!structureRow) {
      return null;
    }

    let [warehouseRow] = await ctx.db.execute<{ id: string }>(
      sql`select id from warehouses where structure_id = ${actor.structureId} and is_default = true limit 1`
    );
    let [unitRow] = await ctx.db.execute<{ id: string }>(
      sql`select id from units where structure_id = ${actor.structureId} and code = 'unite' limit 1`
    );

    // Backfill fallback: structures created before createStructureAction
    // existed (e.g. the seeded demo account) have no implicit default
    // warehouse/unit yet -- create them lazily, once, the same way a
    // brand-new structure gets them. Idempotent by construction (checked
    // above first); worst case on a genuine race is one harmless extra
    // row, acceptable for this one-time bootstrap fallback.
    if (!warehouseRow) {
      [warehouseRow] = await ctx.db.execute<{ id: string }>(sql`
        insert into warehouses (structure_id, name, is_default)
        values (${actor.structureId}, 'Entrepôt principal', true)
        returning id
      `);
    }
    if (!unitRow) {
      [unitRow] = await ctx.db.execute<{ id: string }>(sql`
        insert into units (structure_id, code, name)
        values (${actor.structureId}, 'unite', 'Unité')
        returning id
      `);
    }

    const products = await catalogService.listProducts(ctx, { activeOnly: true });
    const categories = await catalogService.listCategories(ctx);
    const warehouseId = warehouseRow?.id ?? null;
    const levels = warehouseId
      ? await inventoryService.getStockLevels(ctx, { warehouseId })
      : [];
    const quantityByProductId = new Map(levels.map((l) => [l.productId, l.quantity]));

    return {
      structureName: structureRow.name,
      countryCode: structureRow.countryCode,
      currencyCode: structureRow.currencyCode,
      warehouseId,
      unitId: unitRow?.id ?? null,
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        defaultPriceMinor: p.defaultPriceMinor,
        defaultCostMinor: p.defaultCostMinor,
        lowStockThreshold: p.lowStockThreshold,
        quantity: quantityByProductId.get(p.id) ?? "0.0000",
        categoryId: p.categoryId,
        categoryName: p.categoryName,
      })),
      categories: categories.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name })),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <ProductListClient
      structureId={structureId}
      structureName={data.structureName}
      currency={currencyForCountry(data.countryCode)}
      canEditCatalog={can(actor, "product:write")}
      canReceiveStock={can(actor, "stock:receive")}
      warehouseId={data.warehouseId}
      unitId={data.unitId}
      currencyCodeForActions={data.currencyCode}
      products={data.products}
      categories={data.categories}
      createProductAction={createProductAction.bind(null, structureId)}
      receiveStockAction={receiveStockAction.bind(null, structureId)}
      createCategoryAction={createCategoryAction.bind(null, structureId)}
      updateCategoryAction={updateCategoryAction.bind(null, structureId)}
      deleteCategoryAction={deleteCategoryAction.bind(null, structureId)}
      assignProductsToCategoryAction={assignProductsToCategoryAction.bind(null, structureId)}
    />
  );
}
