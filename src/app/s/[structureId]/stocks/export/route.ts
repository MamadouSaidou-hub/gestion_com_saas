import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { resolveStoreScope } from "@/modules/tenancy/permissions";
import { inventoryService } from "@/modules/inventory";
import { rowsToCsv, auditCsvExport, csvResponse } from "@/platform/export/csv";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ structureId: string }> }
) {
  const { structureId } = await params;
  const url = new URL(request.url);
  const requestedWarehouseId = url.searchParams.get("warehouseId");

  try {
    const session = await getSession();
    if (!session) {
      return new Response("Unauthenticated", { status: 401 });
    }
    const actor = await resolveActor(session, structureId);

    const csv = await withTenantSession(actor, async (ctx) => {
      const storeScope = resolveStoreScope(actor, requestedWarehouseId);
      const filter = { warehouseId: storeScope ?? undefined, limit: 1000 };
      const rows = await inventoryService.exportMovementsCsv(ctx, filter);
      const csvBody = rowsToCsv(rows, [
        { header: "Date", value: (r) => r.occurredAt },
        { header: "Produit", value: (r) => r.productId },
        { header: "Magasin", value: (r) => r.warehouseId },
        { header: "Sens", value: (r) => r.direction },
        { header: "Quantité", value: (r) => r.quantity },
        { header: "Coût unitaire", value: (r) => r.unitCostMinor },
        { header: "Motif", value: (r) => r.reason },
      ]);
      await auditCsvExport(ctx, {
        action: "stock_movement.exported",
        targetType: "stock_movement",
        filters: { warehouseId: requestedWarehouseId },
        rowCount: rows.length,
      });
      return csvBody;
    });

    return csvResponse(csv, `mouvements-stock-${structureId}.csv`);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return new Response("Unauthenticated", { status: 401 });
    }
    if (err instanceof NotAMemberError) {
      return new Response("Not found", { status: 404 });
    }
    if (err instanceof ForbiddenError) {
      return new Response("Forbidden", { status: 403 });
    }
    throw err;
  }
}
