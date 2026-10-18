import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { catalogService } from "@/modules/catalog";
import { rowsToCsv, auditCsvExport, csvResponse } from "@/platform/export/csv";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ structureId: string }> }
) {
  const { structureId } = await params;
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;

  try {
    const session = await getSession();
    if (!session) {
      return new Response("Unauthenticated", { status: 401 });
    }
    const actor = await resolveActor(session, structureId);

    const csv = await withTenantSession(actor, async (ctx) => {
      const filter = { activeOnly: true, search };
      const rows = await catalogService.exportProductsCsv(ctx, filter);
      const csvBody = rowsToCsv(rows, [
        { header: "SKU", value: (r) => r.sku },
        { header: "Nom", value: (r) => r.name },
        { header: "Rayon", value: (r) => r.categoryName ?? "" },
        { header: "Prix", value: (r) => r.defaultPriceMinor },
        { header: "Coût", value: (r) => r.defaultCostMinor },
        { header: "Devise", value: (r) => r.currencyCode },
        { header: "Actif", value: (r) => (r.isActive ? "oui" : "non") },
      ]);
      await auditCsvExport(ctx, {
        action: "product.exported",
        targetType: "product",
        filters: { search: search ?? null },
        rowCount: rows.length,
      });
      return csvBody;
    });

    return csvResponse(csv, `produits-${structureId}.csv`);
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
