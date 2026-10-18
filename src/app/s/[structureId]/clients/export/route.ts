import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { resolveStoreScope } from "@/modules/tenancy/permissions";
import { catalogService } from "@/modules/catalog";
import { salesService } from "@/modules/sales";
import { rowsToCsv, auditCsvExport, csvResponse } from "@/platform/export/csv";

// GET /s/[structureId]/clients/export -- CSV export of the clients screen.
// Re-runs the SAME store-scoping composition the list page does (resolve
// store scope -> salesService.listCustomerIdsForStore for a gerant ->
// catalogService.exportCustomersCsv with that id set), never a separate
// "export everything" query.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ structureId: string }> }
) {
  const { structureId } = await params;
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;
  const requestedWarehouseId = url.searchParams.get("warehouseId");

  try {
    const session = await getSession();
    if (!session) {
      return new Response("Unauthenticated", { status: 401 });
    }
    const actor = await resolveActor(session, structureId);

    const csv = await withTenantSession(actor, async (ctx) => {
      const storeScope = resolveStoreScope(actor, requestedWarehouseId);
      const ids = storeScope ? await salesService.listCustomerIdsForStore(ctx, storeScope) : undefined;

      const rows = await catalogService.exportCustomersCsv(ctx, { activeOnly: true, search, ids });
      const csvBody = rowsToCsv(rows, [
        { header: "Nom", value: (r) => r.name },
        { header: "Téléphone", value: (r) => r.phone ?? "" },
        { header: "Email", value: (r) => r.email ?? "" },
        { header: "Actif", value: (r) => (r.isActive ? "oui" : "non") },
        { header: "Plafond crédit", value: (r) => r.creditLimitMinor ?? "" },
        { header: "Délai paiement (j)", value: (r) => r.defaultPaymentTermsDays?.toString() ?? "" },
      ]);
      await auditCsvExport(ctx, {
        action: "customer.exported",
        targetType: "customer",
        filters: { search: search ?? null, warehouseId: requestedWarehouseId },
        rowCount: rows.length,
      });
      return csvBody;
    });

    return csvResponse(csv, `clients-${structureId}.csv`);
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
