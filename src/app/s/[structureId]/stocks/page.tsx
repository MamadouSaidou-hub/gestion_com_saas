import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can, resolveStoreScope } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { catalogService } from "@/modules/catalog";
import { inventoryService } from "@/modules/inventory";
import { stockTransfersService } from "@/modules/stock-transfers";
import {
  openStockCountAction,
  validateStockCountAction,
} from "@/modules/stock-transfers/api/actions";
import { StockMovementsClient } from "./stock-movements-client";

// Gated, structure-scoped page: /s/[structureId]/stocks -- the stock
// MOVEMENT LEDGER (in/out history per product) + the physical counting
// flow + the derived in-transit figure. Real data, wired to inventory +
// stock-transfers (this phase) -- no more mock-stock-movements.ts.
export const dynamic = "force-dynamic";

export default async function StocksPage({
  params,
  searchParams,
}: {
  params: Promise<{ structureId: string }>;
  searchParams: Promise<{ warehouseId?: string }>;
}) {
  const { structureId } = await params;
  const { warehouseId: requestedWarehouseId } = await searchParams;

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
      .select({ name: structures.name })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!structureRow) {
      return null;
    }

    const allWarehouses = await catalogService.listWarehouses(ctx, { activeOnly: true });
    const storeOptions = allWarehouses.filter((w) => w.kind === "store").map((w) => ({ id: w.id, name: w.name }));
    const storeScope = resolveStoreScope(
      actor,
      requestedWarehouseId && storeOptions.some((o) => o.id === requestedWarehouseId) ? requestedWarehouseId : null
    );
    const gerantStoreName = actor.warehouseId
      ? allWarehouses.find((w) => w.id === actor.warehouseId)?.name ?? null
      : null;

    const products = await catalogService.listProducts(ctx, { activeOnly: true });
    const productNameById = new Map(products.map((p) => [p.id, { name: p.name, sku: p.sku }]));

    const movements = await inventoryService.listMovements(ctx, {
      warehouseId: storeScope ?? undefined,
      limit: 100,
    });
    const inTransitByProduct = await stockTransfersService.getInTransitByProduct(ctx, storeScope);
    const varianceLines = await stockTransfersService.listVarianceLines(ctx, { storeScope, limit: 30 });

    return {
      structureName: structureRow.name,
      storeOptions,
      storeScope,
      gerantStoreName,
      products: products
        .filter((p) => p.isActive)
        .map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
      movements: movements.map((m) => ({
        ...m,
        productName: productNameById.get(m.productId)?.name ?? m.productId,
      })),
      inTransitByProduct,
      varianceLines: varianceLines.map((v) => ({
        ...v,
        productName: productNameById.get(v.productId)?.name ?? v.productId,
        storeName: allWarehouses.find((w) => w.id === v.warehouseId)?.name ?? v.warehouseId,
      })),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <StockMovementsClient
      structureId={structureId}
      structureName={data.structureName}
      storeOptions={data.storeOptions}
      gerantStoreName={data.gerantStoreName}
      currentWarehouseId={data.storeScope ?? data.storeOptions[0]?.id ?? null}
      products={data.products}
      movements={data.movements}
      inTransitByProduct={data.inTransitByProduct}
      varianceLines={data.varianceLines}
      canAdjustStock={can(actor, "stock:adjust")}
      canOpenCount={can(actor, "count:open")}
      canValidateCount={can(actor, "count:validate")}
      openStockCountAction={openStockCountAction.bind(null, structureId)}
      validateStockCountAction={validateStockCountAction.bind(null, structureId)}
    />
  );
}
