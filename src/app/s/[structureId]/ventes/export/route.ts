import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { salesService } from "@/modules/sales";
import { rowsToCsv, auditCsvExport, csvResponse } from "@/platform/export/csv";

// GET /s/[structureId]/ventes/export -- CSV export of the sales history
// screen. Re-runs `salesService.exportSalesCsv` with the EXACT same
// searchParams the list page (`/ventes`) reads (same filter shape, same
// `listSales` call underneath) -- never a separate "export everything"
// query. Gated on `report:export` (inside exportSalesCsv, first line).
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ structureId: string }> }
) {
  const { structureId } = await params;
  const url = new URL(request.url);
  const filter = {
    warehouseId: url.searchParams.get("warehouseId") ?? undefined,
    customerId: url.searchParams.get("customerId") ?? undefined,
    paymentStatus:
      (url.searchParams.get("paymentStatus") as "unpaid" | "partial" | "paid" | null) ?? undefined,
    ticketNumber: url.searchParams.get("ticketNumber") ?? undefined,
    periodFrom: url.searchParams.get("periodFrom") ?? undefined,
    periodTo: url.searchParams.get("periodTo") ?? undefined,
  };

  try {
    const session = await getSession();
    if (!session) {
      return new Response("Unauthenticated", { status: 401 });
    }
    const actor = await resolveActor(session, structureId);

    const csv = await withTenantSession(actor, async (ctx) => {
      const rows = await salesService.exportSalesCsv(ctx, filter);
      const csvBody = rowsToCsv(rows, [
        { header: "Ticket", value: (r) => r.ticketNumber ?? "" },
        { header: "Date", value: (r) => r.confirmedAt ?? "" },
        { header: "Statut paiement", value: (r) => r.paymentStatus },
        { header: "Total", value: (r) => r.totalMinor },
        { header: "Payé", value: (r) => r.paidMinor },
        { header: "Devise", value: (r) => r.currencyCode },
        { header: "Client", value: (r) => r.customerId ?? "" },
        { header: "Magasin", value: (r) => r.warehouseId },
      ]);
      await auditCsvExport(ctx, {
        action: "sale.exported",
        targetType: "sale",
        filters: filter,
        rowCount: rows.length,
      });
      return csvBody;
    });

    return csvResponse(csv, `ventes-${structureId}.csv`);
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
