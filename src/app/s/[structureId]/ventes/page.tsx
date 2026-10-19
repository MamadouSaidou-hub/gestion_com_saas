import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { salesService } from "@/modules/sales";
import { catalogService } from "@/modules/catalog";
import { SalesHistoryClient } from "./sales-history-client";

// Gated, structure-scoped page: /s/[structureId]/ventes -- the sales
// history screen (listSales). Honours BOTH scoping axes (scope 'own'/'all'
// AND storeScope) inside salesService.listSales itself -- this page only
// forwards the searchParams it was given, it never computes scope.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function VentesPage({
  params,
  searchParams,
}: {
  params: Promise<{ structureId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { structureId } = await params;
  const sp = await searchParams;

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

  const filter = {
    warehouseId: sp.warehouseId,
    customerId: sp.customerId,
    paymentStatus: sp.paymentStatus as "unpaid" | "partial" | "paid" | undefined,
    ticketNumber: sp.ticketNumber,
    periodFrom: sp.periodFrom,
    periodTo: sp.periodTo,
    customerSearch: sp.customerSearch,
  };

  const data = await withTenantSession(actor, async (ctx) => {
    const [structureRow] = await ctx.db
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!structureRow) {
      return null;
    }

    const allWarehouses = await catalogService.listWarehouses(ctx, { activeOnly: true });
    const storeOptions = allWarehouses
      .filter((w) => w.kind === "store")
      .map((w) => ({ id: w.id, name: w.name }));

    // Free-text customer filter: `listSales` only accepts a single
    // `customerId` (uuid), so a free-text name is resolved to the set of
    // matching customers FIRST (catalogService.listCustomers' own
    // `search` support), then `listSales` is run once per match and the
    // results merged -- `listSales` itself still re-applies scope/
    // storeScope for EVERY one of those calls, so a gerant never sees a
    // sale outside their store just because the name search was
    // unrestricted.
    let sales;
    if (filter.customerSearch && filter.customerSearch.trim() !== "") {
      const matches = await catalogService.listCustomers(ctx, { search: filter.customerSearch.trim() });
      const resultsPerMatch = await Promise.all(
        matches.map((c) => salesService.listSales(ctx, { ...filter, customerId: c.id }))
      );
      const merged = resultsPerMatch.flat();
      merged.sort((a, b) => (b.confirmedAt ?? "").localeCompare(a.confirmedAt ?? ""));
      sales = merged;
    } else {
      sales = await salesService.listSales(ctx, filter);
    }

    return {
      structureName: structureRow.name,
      countryCode: structureRow.countryCode,
      storeOptions,
      sales,
      warehouseNameById: Object.fromEntries(allWarehouses.map((w) => [w.id, w.name])),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <SalesHistoryClient
      structureId={structureId}
      structureName={data.structureName}
      currency={currencyForCountry(data.countryCode)}
      storeOptions={data.storeOptions}
      sales={data.sales}
      warehouseNameById={data.warehouseNameById}
      filter={filter}
      canExport={can(actor, "report:export")}
    />
  );
}
