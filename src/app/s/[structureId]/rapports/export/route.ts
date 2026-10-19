import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { analyticsService, type PeriodGranularity } from "@/modules/analytics";
import { rowsToCsv, auditCsvExport, csvResponse } from "@/platform/export/csv";

// GET /s/[structureId]/rapports/export -- CSV export of the "Rapports"
// screen's revenue-by-store breakdown. Re-runs `analyticsService.
// exportReportsCsv` with the EXACT same searchParams the screen itself
// reads (same period/store filter, same `getReports` call underneath) --
// never a separate "export everything" query. Gated on `report:export`
// (inside exportReportsCsv, first line).
export const dynamic = "force-dynamic";

function isPeriod(value: string | null): value is PeriodGranularity {
  return value === "day" || value === "week" || value === "month";
}

export async function GET(request: Request, { params }: { params: Promise<{ structureId: string }> }) {
  const { structureId } = await params;
  const url = new URL(request.url);
  const period: PeriodGranularity = isPeriod(url.searchParams.get("period")) ? (url.searchParams.get("period") as PeriodGranularity) : "month";
  const warehouseId = url.searchParams.get("warehouseId") ?? undefined;

  try {
    const session = await getSession();
    if (!session) {
      return new Response("Unauthenticated", { status: 401 });
    }
    const actor = await resolveActor(session, structureId);

    const csv = await withTenantSession(actor, async (ctx) => {
      const reports = await analyticsService.exportReportsCsv(ctx, { period, warehouseId });
      const csvBody = rowsToCsv(reports.revenueByStore, [
        { header: "Magasin", value: (r) => r.warehouseId },
        { header: "Chiffre d'affaires", value: (r) => r.netMinor },
        { header: "Nombre de ventes", value: (r) => String(r.saleCount) },
      ]);
      await auditCsvExport(ctx, {
        action: "report.exported",
        targetType: "report",
        filters: { period, warehouseId: warehouseId ?? null },
        rowCount: reports.revenueByStore.length,
      });
      return csvBody;
    });

    return csvResponse(csv, `rapports-${structureId}.csv`);
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
