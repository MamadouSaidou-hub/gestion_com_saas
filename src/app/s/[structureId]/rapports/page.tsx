import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StoreSelector, LockedStoreLabel } from "@/components/nav/store-selector";
import { catalogService } from "@/modules/catalog";
import { analyticsService, type PeriodGranularity } from "@/modules/analytics";

export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

function isPeriod(value: string | undefined): value is PeriodGranularity {
  return value === "day" || value === "week" || value === "month";
}

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ structureId: string }>;
  searchParams: Promise<{ warehouseId?: string; period?: string }>;
}) {
  const { structureId } = await params;
  const { warehouseId: requestedWarehouseId, period: requestedPeriod } = await searchParams;
  const period: PeriodGranularity = isPeriod(requestedPeriod) ? requestedPeriod : "month";

  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  let actor;
  try {
    actor = await resolveActor(session, structureId);
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/login");
    if (err instanceof NotAMemberError) notFound();
    throw err;
  }

  if (!can(actor, "dashboard:read_financials")) {
    throw new ForbiddenError(dict.reports.forbidden);
  }

  const canExport = can(actor, "report:export");

  const data = await withTenantSession(actor, async (ctx) => {
    const [structureRow] = await ctx.db
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!structureRow) return null;

    const [allWarehouses, reports] = await Promise.all([
      catalogService.listWarehouses(ctx, { activeOnly: true }),
      analyticsService.getReports(ctx, { period, warehouseId: requestedWarehouseId ?? null }),
    ]);
    return { structureName: structureRow.name, countryCode: structureRow.countryCode, allWarehouses, reports };
  });

  if (!data) {
    notFound();
  }

  const currency = currencyForCountry(data.countryCode);
  const storeOptions = data.allWarehouses.filter((w) => w.kind === "store").map((w) => ({ id: w.id, name: w.name }));
  const warehouseNameById = new Map(data.allWarehouses.map((w) => [w.id, w.name]));
  const gerantStoreName = actor.warehouseId
    ? data.allWarehouses.find((w) => w.id === actor.warehouseId)?.name ?? null
    : null;
  const selectedWarehouseId =
    requestedWarehouseId && storeOptions.some((o) => o.id === requestedWarehouseId) ? requestedWarehouseId : null;
  const { reports } = data;

  const exportHref = `/s/${structureId}/rapports/export?period=${period}${
    selectedWarehouseId ? `&warehouseId=${selectedWarehouseId}` : ""
  }`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Breadcrumb items={[{ label: dict.nav.captionPilotage }, { label: dict.reports.title }]} />

      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{dict.reports.title}</h1>
        <div className="flex items-center gap-3">
          {gerantStoreName ? (
            <LockedStoreLabel name={gerantStoreName} />
          ) : storeOptions.length > 1 ? (
            <StoreSelector options={storeOptions} selectedId={selectedWarehouseId} />
          ) : null}
          <form method="get" className="flex items-center gap-1">
            {selectedWarehouseId && <input type="hidden" name="warehouseId" value={selectedWarehouseId} />}
            <label htmlFor="period" className="sr-only">
              {dict.reports.periodLabel}
            </label>
            <select
              id="period"
              name="period"
              defaultValue={period}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="day">{dict.treasury.periodDay}</option>
              <option value="week">{dict.treasury.periodWeek}</option>
              <option value="month">{dict.treasury.periodMonth}</option>
            </select>
            <noscript>
              <button type="submit" className="h-9 rounded-md border border-input px-2 text-sm">
                {dict.common.save}
              </button>
            </noscript>
          </form>
        </div>
      </header>

      {canExport && (
        <a
          href={exportHref}
          className="mb-4 inline-block h-touch rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
        >
          {dict.reports.exportCta}
        </a>
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{dict.reports.revenueByStoreTitle}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {reports.revenueByStore.length === 0 ? (
            <p className="text-sm text-muted-foreground">{dict.dashboard.topProductsEmpty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {reports.revenueByStore.map((row) => (
                <li key={row.warehouseId} className="flex items-center justify-between py-2 text-sm">
                  <span>{warehouseNameById.get(row.warehouseId) ?? row.warehouseId}</span>
                  <span className="tabular-nums font-medium">{formatMoney(Number(row.netMinor), currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{dict.reports.topProductsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {reports.topProductsByRevenue.length === 0 ? (
            <p className="text-sm text-muted-foreground">{dict.dashboard.topProductsEmpty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {reports.topProductsByRevenue.map((p) => (
                <li key={p.productId} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate">{p.name}</span>
                  <span className="tabular-nums font-medium">{formatMoney(Number(p.revenueMinor), currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
