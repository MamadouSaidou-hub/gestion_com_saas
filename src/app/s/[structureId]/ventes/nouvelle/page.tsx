import { eq, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { assertCan, can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { ForbiddenError, NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { catalogService } from "@/modules/catalog";
import { inventoryService } from "@/modules/inventory";
import { PosClient } from "./pos-client";
import type { SupportedCurrency } from "@/lib/money";

// Gated, structure-scoped page: /s/[structureId]/ventes/nouvelle -- now
// wired to the REAL catalog/inventory/sales modules (Phase 1 step 6).
// Page-level authz (`sale:create`) re-checked here, same as before; the
// catalog/stock data below is real.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function NouvelleVentePage({
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

  try {
    assertCan(actor, "sale:create");
  } catch (err) {
    if (err instanceof ForbiddenError) {
      notFound(); // no information disclosure about the page's existence
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

    const [warehouseRow] = await ctx.db.execute<{ id: string }>(
      sql`select id from warehouses where structure_id = ${actor.structureId} and is_default = true limit 1`
    );
    if (!warehouseRow) {
      // No product/stock bootstrap has happened yet for this structure --
      // the POS has nothing sellable either way.
      return { structureRow, warehouseId: null, products: [] };
    }

    const products = await catalogService.listProducts(ctx, { activeOnly: true });
    const levels = await inventoryService.getStockLevels(ctx, { warehouseId: warehouseRow.id });
    const quantityByProductId = new Map(levels.map((l) => [l.productId, l.quantity]));

    return {
      structureRow,
      warehouseId: warehouseRow.id,
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        priceMinor: p.defaultPriceMinor,
        quantity: quantityByProductId.get(p.id) ?? "0.0000",
        lowStockThreshold: p.lowStockThreshold,
        categoryId: p.categoryId,
        categoryName: p.categoryName,
      })),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <PosClient
      structureId={structureId}
      userId={actor.userId}
      structureName={data.structureRow.name}
      currency={currencyForCountry(data.structureRow.countryCode)}
      currencyCode={data.structureRow.currencyCode}
      warehouseId={data.warehouseId}
      products={data.products}
      canRecordPayment={can(actor, "payment:record")}
    />
  );
}
