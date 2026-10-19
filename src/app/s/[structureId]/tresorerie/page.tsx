import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can, storeScopeFor } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError, ForbiddenError } from "@/platform/errors";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StoreSelector, LockedStoreLabel } from "@/components/nav/store-selector";
import { catalogService } from "@/modules/catalog";
import { salesService } from "@/modules/sales";
import { analyticsService, type PeriodGranularity } from "@/modules/analytics";
import { recordPaymentAction } from "@/modules/billing/api";
import { NewPaymentSection } from "./tresorerie-client";

export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

function isPeriod(value: string | undefined): value is PeriodGranularity {
  return value === "day" || value === "week" || value === "month";
}

export default async function TreasuryPage({
  params,
  searchParams,
}: {
  params: Promise<{ structureId: string }>;
  searchParams: Promise<{ warehouseId?: string; period?: string }>;
}) {
  const { structureId } = await params;
  const { warehouseId: requestedWarehouseId, period: requestedPeriod } = await searchParams;
  const period: PeriodGranularity = isPeriod(requestedPeriod) ? requestedPeriod : "day";

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

  if (!can(actor, "treasury:read")) {
    throw new ForbiddenError(dict.treasury.forbidden);
  }

  const canRecordPayment = can(actor, "payment:record");

  const data = await withTenantSession(actor, async (ctx) => {
    const [structureRow] = await ctx.db
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!structureRow) return null;

    const allWarehouses = await catalogService.listWarehouses(ctx, { activeOnly: true });
    const treasury = await analyticsService.getTreasury(ctx, { period, warehouseId: requestedWarehouseId ?? null });

    let openSales: Array<{ id: string; ticketNumber: string | null; balanceMinor: number }> = [];
    if (canRecordPayment) {
      const own = storeScopeFor(actor);
      const all = await salesService.listOpenSalesForBilling(ctx);
      openSales = all
        .filter((s) => own === null || s.warehouseId === own)
        .map((s) => ({
          id: s.id,
          ticketNumber: s.ticketNumber,
          balanceMinor: Number(s.totalMinor) - Number(s.paidMinor),
        }));
    }

    return { structureName: structureRow.name, countryCode: structureRow.countryCode, allWarehouses, treasury, openSales };
  });

  if (!data) {
    notFound();
  }

  const currency = currencyForCountry(data.countryCode);
  const storeOptions = data.allWarehouses.filter((w) => w.kind === "store").map((w) => ({ id: w.id, name: w.name }));
  const gerantStoreName = actor.warehouseId
    ? data.allWarehouses.find((w) => w.id === actor.warehouseId)?.name ?? null
    : null;
  const selectedWarehouseId =
    requestedWarehouseId && storeOptions.some((o) => o.id === requestedWarehouseId) ? requestedWarehouseId : null;
  const { treasury } = data;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Breadcrumb items={[{ label: dict.nav.captionPilotage }, { label: dict.treasury.title }]} />

      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{dict.treasury.title}</h1>
        <div className="flex items-center gap-3">
          {gerantStoreName ? (
            <LockedStoreLabel name={gerantStoreName} />
          ) : storeOptions.length > 1 ? (
            <StoreSelector options={storeOptions} selectedId={selectedWarehouseId} />
          ) : null}
          <form method="get" className="flex items-center gap-1">
            {selectedWarehouseId && <input type="hidden" name="warehouseId" value={selectedWarehouseId} />}
            <label htmlFor="period" className="sr-only">
              {dict.treasury.periodLabel}
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

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {dict.treasury.cashSalesLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(Number(treasury.cashSalesMinor), currency)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {dict.treasury.receivableCollectionsLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(Number(treasury.receivableCollectionsMinor), currency)}
            </p>
          </CardContent>
        </Card>
        <Card className="col-span-2 bg-success text-success-foreground">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium opacity-90">{dict.treasury.totalEncaisseLabel}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-2xl font-bold tabular-nums">
              {formatMoney(Number(treasury.totalEncaisseMinor), currency)}
            </p>
          </CardContent>
        </Card>
        <Card className="col-span-2">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {dict.treasury.receivablesOwedLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(Number(treasury.receivablesOwedToUsMinor), currency)}
            </p>
          </CardContent>
        </Card>

        {treasury.supplier ? (
          <>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {dict.treasury.supplierPaymentsLabel}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-lg font-semibold tabular-nums">
                  {formatMoney(Number(treasury.supplier.paymentsMadeMinor), currency)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {dict.treasury.supplierDebtLabel}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-lg font-semibold tabular-nums">
                  {formatMoney(Number(treasury.supplier.debtOwedMinor), currency)}
                </p>
              </CardContent>
            </Card>
          </>
        ) : (
          <p className="col-span-2 text-xs text-muted-foreground">{dict.treasury.supplierSectionHidden}</p>
        )}
      </div>

      {canRecordPayment && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">{dict.treasury.newPaymentTitle}</h2>
          <NewPaymentSection
            structureId={structureId}
            currency={currency}
            openSales={data.openSales}
            recordPaymentAction={recordPaymentAction.bind(null, structureId)}
          />
        </section>
      )}
    </div>
  );
}
