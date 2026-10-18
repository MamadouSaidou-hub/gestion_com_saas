import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { resolveStoreScope } from "@/modules/tenancy/permissions";
import { stockTransfersService } from "@/modules/stock-transfers";
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
      const rows = await stockTransfersService.exportTransfersCsv(ctx, { storeScope });
      const csvBody = rowsToCsv(rows, [
        { header: "Référence", value: (r) => r.reference },
        { header: "Date", value: (r) => r.createdAt },
        { header: "Origine", value: (r) => r.fromWarehouseId },
        { header: "Destination", value: (r) => r.toWarehouseId },
        { header: "Statut", value: (r) => r.status },
        { header: "Articles", value: (r) => r.lines.length.toString() },
      ]);
      await auditCsvExport(ctx, {
        action: "transfer.exported",
        targetType: "stock_transfer",
        filters: { warehouseId: requestedWarehouseId },
        rowCount: rows.length,
      });
      return csvBody;
    });

    return csvResponse(csv, `transferts-${structureId}.csv`);
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
