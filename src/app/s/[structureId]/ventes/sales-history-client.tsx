"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { StoreSelector } from "@/components/nav/store-selector";
import type { SaleSummaryDto } from "@/modules/sales";

const STATUS_FILTERS: Array<{ value: "unpaid" | "partial" | "paid" | ""; label: string }> = [
  { value: "", label: dict.salesHistory.filterAll },
  { value: "unpaid", label: dict.salesHistory.statusUnpaid },
  { value: "partial", label: dict.salesHistory.statusPartial },
  { value: "paid", label: dict.salesHistory.statusPaid },
];

function statusVariant(status: "unpaid" | "partial" | "paid"): "success" | "secondary" | "outline" {
  if (status === "paid") return "success";
  if (status === "partial") return "secondary";
  return "outline";
}

function formatDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function SalesHistoryClient({
  structureId,
  structureName,
  currency,
  storeOptions,
  sales,
  filter,
  canExport,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
  storeOptions: Array<{ id: string; name: string }>;
  sales: SaleSummaryDto[];
  warehouseNameById: Record<string, string>;
  filter: {
    warehouseId?: string;
    customerId?: string;
    paymentStatus?: "unpaid" | "partial" | "paid";
    ticketNumber?: string;
    periodFrom?: string;
    periodTo?: string;
    customerSearch?: string;
  };
  canExport: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParam(name: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(name, value);
    } else {
      params.delete(name);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  const exportHref = `/s/${structureId}/ventes/export?${searchParams.toString()}`;

  return (
    <div className="min-h-screen bg-background pb-6">
      <header className="sticky top-0 z-30 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <a
            href={`/s/${structureId}/dashboard`}
            aria-label="Retour au tableau de bord"
            className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{dict.salesHistory.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
          {canExport && (
            <a
              href={exportHref}
              className="flex h-touch items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {dict.salesHistory.exportCta}
            </a>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            type="text"
            defaultValue={filter.ticketNumber ?? ""}
            onBlur={(e) => updateParam("ticketNumber", e.target.value.trim())}
            placeholder={dict.salesHistory.searchPlaceholder}
            aria-label={dict.salesHistory.searchPlaceholder}
            className="max-w-[160px]"
          />
          <Input
            type="text"
            defaultValue={filter.customerSearch ?? ""}
            onBlur={(e) => updateParam("customerSearch", e.target.value.trim())}
            placeholder={dict.salesHistory.customerSearchPlaceholder}
            aria-label={dict.salesHistory.customerSearchPlaceholder}
            className="max-w-[160px]"
          />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            {dict.salesHistory.filterPeriodFrom}
            <input
              type="date"
              defaultValue={filter.periodFrom ?? ""}
              onChange={(e) => updateParam("periodFrom", e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            {dict.salesHistory.filterPeriodTo}
            <input
              type="date"
              defaultValue={filter.periodTo ?? ""}
              onChange={(e) => updateParam("periodTo", e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          {storeOptions.length > 1 && (
            <StoreSelector options={storeOptions} selectedId={filter.warehouseId ?? null} />
          )}
        </div>

        <div role="group" aria-label={dict.salesHistory.filterPaymentStatus} className="mt-3 flex gap-2 overflow-x-auto">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value || "all"}
              type="button"
              onClick={() => updateParam("paymentStatus", f.value)}
              aria-pressed={(filter.paymentStatus ?? "") === f.value}
              className={
                (filter.paymentStatus ?? "") === f.value
                  ? "shrink-0 rounded-full border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
                  : "shrink-0 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent"
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.salesHistory.title },
          ]}
        />
        <p className="mb-2 text-sm text-muted-foreground">
          {sales.length} {dict.salesHistory.title.toLowerCase()}
        </p>

        {sales.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.salesHistory.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {sales.map((sale) => (
              <li key={sale.id}>
                <a
                  href={`/s/${structureId}/ventes/${sale.id}`}
                  className="flex items-center gap-3 p-4 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {dict.salesHistory.ticketColumn} {sale.ticketNumber ?? "--"}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{formatDate(sale.confirmedAt)}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <p className="tabular-nums font-semibold">{formatMoney(Number(sale.totalMinor), currency)}</p>
                    <Badge variant={statusVariant(sale.paymentStatus)}>
                      {sale.paymentStatus === "paid"
                        ? dict.salesHistory.statusPaid
                        : sale.paymentStatus === "partial"
                          ? dict.salesHistory.statusPartial
                          : dict.salesHistory.statusUnpaid}
                    </Badge>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
