import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, ChevronDown, FileText, Package, Receipt, Truck, Users, ClipboardList } from "lucide-react";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import type { Actor } from "@/modules/tenancy/types";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { dict } from "@/lib/i18n";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { analyticsService } from "@/modules/analytics";
import { updateStructureDisplayName } from "./actions";

// Gated, structure-scoped page: /s/[structureId]/dashboard -- now wired to
// the REAL analytics module (Phase 1 step 6). Two independent
// `withTenantSession` calls behind two Suspense boundaries
// (HeadlineSection, HeavyTilesSection) so the headline tile (CA + encaissé
// du jour) can paint as soon as ITS small query resolves, instead of
// waiting on the heavier top-products/margin/seller-breakdown queries.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ structureId: string }>;
}) {
  const { structureId } = await params;

  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  let actor: Actor;
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

  const structure = await withTenantSession(actor, async ({ db }) => {
    const [row] = await db
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    return row;
  });

  if (!structure) {
    notFound();
  }

  const canEditSettings = can(actor, "settings:write");
  const canSell = can(actor, "sale:create");
  const currency = currencyForCountry(structure.countryCode);

  const quickLinks = [
    { href: `/s/${structureId}/ventes/nouvelle`, label: dict.dashboard.navSales, icon: Receipt, show: canSell },
    { href: `/s/${structureId}/produits`, label: dict.dashboard.navStock, icon: Package, show: true },
    { href: `/s/${structureId}/fournisseurs`, label: dict.dashboard.navSuppliers, icon: Truck, show: true },
    { href: `/s/${structureId}/factures`, label: dict.dashboard.navInvoices, icon: FileText, show: true },
    { href: `/s/${structureId}/stocks`, label: dict.dashboard.navStockMovements, icon: ClipboardList, show: true },
  ].filter((l) => l.show);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Breadcrumb items={[{ label: dict.nav.captionPilotage }, { label: dict.dashboard.title }]} />

      <header className="mb-6">
        <h1 className="text-xl font-semibold">{dict.dashboard.title}</h1>
        <p className="text-sm text-muted-foreground">
          {structure.name} <span aria-hidden="true">&middot;</span> <span className="capitalize">{actor.role}</span>
        </p>
      </header>

      <Suspense fallback={<HeadlineSkeleton />}>
        <HeadlineSection actor={actor} currency={currency} />
      </Suspense>

      <section className="mb-6 mt-4" aria-labelledby="quick-actions-heading">
        <h2 id="quick-actions-heading" className="mb-2 text-sm font-medium text-muted-foreground">
          {dict.dashboard.quickActions}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {quickLinks.map(({ href, label, icon: Icon }) => (
            <a
              key={href}
              href={href}
              className="flex min-h-touch-lg flex-col items-start justify-center gap-1 rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
              <span className="font-medium">{label}</span>
            </a>
          ))}
        </div>
      </section>

      <Suspense fallback={<HeavyTilesSkeleton />}>
        <HeavyTilesSection actor={actor} currency={currency} structureId={structureId} />
      </Suspense>

      {canEditSettings && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{dict.dashboard.settingsSectionTitle}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <form action={updateStructureDisplayName.bind(null, structureId)} className="space-y-3">
              <div>
                <Label htmlFor="name">{dict.dashboard.renameLabel}</Label>
                <Input id="name" name="name" type="text" required maxLength={200} defaultValue={structure.name} />
              </div>
              <Button type="submit">{dict.dashboard.renameSubmit}</Button>
            </form>
            <Separator className="my-4" />
            <a
              href={`/s/${structureId}/parametres/equipe`}
              className="flex min-h-touch items-center gap-2 text-sm font-medium text-primary hover:underline"
            >
              <Users className="h-4 w-4" aria-hidden="true" />
              {dict.dashboard.manageTeam}
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function HeadlineSkeleton() {
  return (
    <Card className="mb-4 bg-primary">
      <CardContent className="space-y-2 p-5">
        <Skeleton className="h-4 w-32 bg-primary-foreground/20" />
        <Skeleton className="h-8 w-40 bg-primary-foreground/20" />
      </CardContent>
    </Card>
  );
}

// Hierarchy decision (see report): "Encaissé" -- actual cash the owner has
// in hand today -- is the ONE hero number, because it's what every other
// figure on this screen ultimately answers to ("did I really get paid").
// CA (brut/net) is real and stays fully legible, but demoted to a smaller,
// clearly-labelled line inside the SAME card rather than an equally-sized
// second tile -- the old 2-up grid gave CA and Encaissé identical visual
// weight, which is exactly the ambiguity client feedback flagged. Nothing
// is hidden: CA brut, CA net (the moment it diverges from brut) and
// Encaissé are all still on screen, just not all shouting at once.
async function HeadlineSection({ actor, currency }: { actor: Actor; currency: SupportedCurrency }) {
  const headline = await withTenantSession(actor, (ctx) => analyticsService.getHeadline(ctx, { period: "day" }));

  if (!headline.financials) {
    // Cashier (or any role without dashboard:read_financials): own sales
    // only -- the shape returned by the service never includes global
    // revenue, so there is nothing to accidentally leak here. The absence
    // of shop-wide financial tiles below is explained explicitly (see
    // `cashierNoFinancialsHint`) so it reads as intentional, not broken.
    return (
      <Card className="mb-4 bg-primary text-primary-foreground">
        <CardContent className="p-5">
          <p className="text-sm opacity-90">{dict.dashboard.myOwnSalesLabel}</p>
          <p className="mt-1 text-4xl font-bold tabular-nums">
            {formatMoney(Number(headline.ownTotalMinor), currency)}
          </p>
          <p className="mt-1 text-sm opacity-90">
            {headline.ownSaleCount} {dict.dashboard.salesCount}
          </p>
          <p className="mt-2 text-xs opacity-80">{dict.dashboard.myOwnSalesHint}</p>
        </CardContent>
      </Card>
    );
  }

  const caDiverges = headline.financials.caNetMinor !== headline.financials.caBrutMinor;

  return (
    <Card className="mb-4 bg-success text-success-foreground">
      <CardContent className="p-5">
        <p className="text-sm opacity-90">{dict.dashboard.encaisseLabel}</p>
        <p className="mt-1 text-4xl font-bold tabular-nums">
          {formatMoney(Number(headline.financials.encaisseMinor), currency)}
        </p>
        <p className="mt-1 text-xs opacity-80">{dict.dashboard.encaisseHint}</p>

        <div className="mt-4 flex gap-5 border-t border-success-foreground/20 pt-3">
          <div>
            <p className="text-xs opacity-80">{dict.dashboard.caLabel}</p>
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(Number(headline.financials.caBrutMinor), currency)}
            </p>
          </div>
          {/* L (security-reviewer follow-up): the brut figure includes
              cancelled sales by design (see analytics module's documented
              CA brut/net split) -- that is correct, but silently showing
              ONLY brut on a day with a cancellation would overstate what
              the shopkeeper actually kept. Surfaced the moment the two
              diverge, not hidden in a tooltip. */}
          {caDiverges && (
            <div>
              <p className="text-xs opacity-80">{dict.dashboard.caNetLabel}</p>
              <p className="text-lg font-semibold tabular-nums">
                {formatMoney(Number(headline.financials.caNetMinor), currency)}
              </p>
            </div>
          )}
        </div>
        <p className="mt-2 text-xs opacity-70">{dict.dashboard.caHint}</p>
      </CardContent>
    </Card>
  );
}

function HeavyTilesSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

async function HeavyTilesSection({
  actor,
  currency,
  structureId,
}: {
  actor: Actor;
  currency: SupportedCurrency;
  structureId: string;
}) {
  const dashboard = await withTenantSession(actor, (ctx) => analyticsService.getDashboard(ctx, { period: "day" }));

  return (
    <div className="space-y-4">
      {/* "À surveiller" -- the second tier of the hierarchy: things that
          may need an ACTION today (restock, chase a client), always
          visible, never behind the disclosure below. Stock alerts apply
          to every role (including a cashier with no financial access);
          receivables only render when the actor can see financials at
          all -- same `dashboard.financials` gate as everything else. */}
      <section aria-labelledby="needs-attention-heading">
        <h2 id="needs-attention-heading" className="mb-2 text-sm font-medium text-muted-foreground">
          {dict.dashboard.needsAttentionTitle}
        </h2>
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
                {dict.dashboard.myStockAlerts}
              </CardTitle>
              {dashboard.lowStockAlerts.length > 0 && (
                <Badge variant="warning">{dashboard.lowStockAlerts.length}</Badge>
              )}
            </CardHeader>
            <CardContent className="pt-0">
              {dashboard.lowStockAlerts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{dict.dashboard.myStockAlertsEmpty}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {dashboard.lowStockAlerts.map((item) => (
                    <li key={item.productId} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="truncate text-sm">{item.name}</span>
                      <Badge variant={Number(item.quantity) <= 0 ? "destructive" : "warning"}>
                        {Number(item.quantity) <= 0
                          ? dict.dashboard.outOfStock
                          : `${dict.dashboard.lowStock} · ${item.quantity}`}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              <a
                href={`/s/${structureId}/produits`}
                className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
              >
                {dict.dashboard.myStockAlertsSeeAll}
              </a>
            </CardContent>
          </Card>

          {dashboard.financials && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>{dict.dashboard.receivablesLabel}</CardTitle>
                <Badge variant="warning">
                  {formatMoney(Number(dashboard.financials.receivables.totalOutstandingMinor), currency)}
                </Badge>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground">{dict.dashboard.receivablesHint}</p>
                {Number(dashboard.financials.receivables.overdueMinor) > 0 && (
                  <p className="mt-2 text-sm font-medium text-destructive">
                    {dict.dashboard.overdueLabel} ·{" "}
                    {formatMoney(Number(dashboard.financials.receivables.overdueMinor), currency)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {!dashboard.financials && (
            <Card className="border-dashed">
              <CardContent className="p-4">
                <p className="text-sm font-medium">{dict.dashboard.cashierNoFinancialsTitle}</p>
                <p className="mt-1 text-xs text-muted-foreground">{dict.dashboard.cashierNoFinancialsHint}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      {/* Third tier: analysis a shop owner checks less often than "did I
          get paid" / "what needs restocking" -- a native <details> keeps
          it one tap away without costing any JS (works even before
          hydration, which matters on the throttled-3G baseline) and
          without competing for attention on first paint. */}
      {dashboard.financials && (
        <details className="group rounded-lg border border-border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            {dict.dashboard.detailsToggle}
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="space-y-4 border-t border-border p-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>{dict.dashboard.saleCountLabel}</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4 pt-0">
                <div>
                  <p className="text-2xl font-bold tabular-nums">{dashboard.financials.saleCount}</p>
                  <p className="text-xs text-muted-foreground">{dict.dashboard.saleCountLabel}</p>
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums">
                    {formatMoney(Number(dashboard.financials.averageBasketMinor), currency)}
                  </p>
                  <p className="text-xs text-muted-foreground">{dict.dashboard.averageBasketLabel}</p>
                </div>
              </CardContent>
              {dashboard.financials.vatMinor !== null && (
                <CardContent className="pt-0">
                  <p className="text-sm text-muted-foreground">
                    {dict.dashboard.vatLabel}: {formatMoney(Number(dashboard.financials.vatMinor), currency)}
                  </p>
                </CardContent>
              )}
            </Card>

            {dashboard.financials.encaisseByMethod.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{dict.dashboard.paymentMethodBreakdown}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="divide-y divide-border">
                    {dashboard.financials.encaisseByMethod.map((m) => (
                      <li key={m.method} className="flex items-center justify-between py-2 text-sm">
                        <span className="capitalize">{m.method.replace("_", " ")}</span>
                        <span className="tabular-nums font-medium">{formatMoney(Number(m.amountMinor), currency)}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>{dict.dashboard.marginLabel}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-2xl font-bold tabular-nums">
                  {formatMoney(Number(dashboard.financials.margin.marginMinor), currency)}
                  {dashboard.financials.margin.marginPct !== null && (
                    <span className="ml-2 text-base font-normal text-muted-foreground">
                      ({dashboard.financials.margin.marginPct.toFixed(1)}%)
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">{dict.dashboard.marginHint}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{dict.dashboard.topProductsLabel}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {dashboard.financials.topProductsByRevenue.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{dict.dashboard.topProductsEmpty}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {dashboard.financials.topProductsByRevenue.map((p) => (
                      <li key={p.productId} className="flex items-center justify-between py-2 text-sm">
                        <span className="truncate">{p.name}</span>
                        <span className="tabular-nums font-medium">{formatMoney(Number(p.revenueMinor), currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {dashboard.financials.sellerBreakdown.length > 1 && (
              <Card>
                <CardHeader>
                  <CardTitle>{dict.dashboard.sellerBreakdownLabel}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="divide-y divide-border">
                    {dashboard.financials.sellerBreakdown.map((s) => (
                      <li key={s.sellerId} className="flex items-center justify-between py-2 text-sm">
                        <span>{s.saleCount} ventes</span>
                        <span className="tabular-nums font-medium">{formatMoney(Number(s.totalMinor), currency)}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
