"use client";

import { useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, Clock, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { MockDataBanner } from "@/components/mock-data-banner";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { MOCK_INVOICES, type InvoiceStatus } from "./mock-invoices";

const STATUS_FILTERS: Array<{ value: InvoiceStatus | "all"; label: string }> = [
  { value: "all", label: dict.invoices.filterAll },
  { value: "pending", label: dict.invoices.statusPending },
  { value: "overdue", label: dict.invoices.statusOverdue },
  { value: "paid", label: dict.invoices.statusPaid },
];

// Status badge mapping -- deliberately does NOT reach for `destructive`
// (red) for "overdue", even though that would read as intuitively urgent:
// the approved design direction reserves red for destructive/void actions
// only and amber for stock alerts only. Distinguished instead via icon +
// variant + weight. Flagged in the handback: a future iteration may want a
// dedicated "danger" status token separate from both, but that's a design-
// system change for the user to approve, not to make silently here.
function statusBadge(status: InvoiceStatus) {
  switch (status) {
    case "paid":
      return { variant: "success" as const, icon: CheckCircle2, label: dict.invoices.statusPaid };
    case "pending":
      return { variant: "secondary" as const, icon: Clock, label: dict.invoices.statusPending };
    case "overdue":
      return { variant: "outline" as const, icon: AlertCircle, label: dict.invoices.statusOverdue };
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function InvoiceListClient({
  structureId,
  structureName,
  currency,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "all">("all");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MOCK_INVOICES.filter((invoice) => {
      if (statusFilter !== "all" && invoice.status !== statusFilter) return false;
      if (!q) return true;
      return invoice.clientName.toLowerCase().includes(q) || invoice.number.toLowerCase().includes(q);
    });
  }, [query, statusFilter]);

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
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{dict.invoices.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
        </div>

        <div className="mt-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={dict.invoices.searchPlaceholder}
              className="pl-9"
              aria-label={dict.invoices.searchPlaceholder}
            />
          </div>
        </div>

        {/* Status filter -- horizontally scrollable pill row, no wrapping, fits
            small screens without pushing content down further. */}
        <div role="group" aria-label="Filtrer par statut" className="mt-3 flex gap-2 overflow-x-auto">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatusFilter(f.value)}
              aria-pressed={statusFilter === f.value}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                statusFilter === f.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent"
              )}
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
            { label: dict.nav.captionGestion },
            { label: dict.invoices.title },
          ]}
        />
        <MockDataBanner />
        <p className="mb-2 text-sm text-muted-foreground">
          {results.length} {dict.invoices.title.toLowerCase()}
        </p>

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.invoices.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {results.map((invoice) => {
              const badge = statusBadge(invoice.status);
              const Icon = badge.icon;
              return (
                <li key={invoice.id} className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{invoice.clientName}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {invoice.number}
                      <span className="mx-1" aria-hidden="true">
                        &middot;
                      </span>
                      {dict.invoices.dueDate} {formatDate(invoice.dueOn)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <p className="tabular-nums font-semibold">{formatMoney(invoice.amount, currency)}</p>
                    <Badge variant={badge.variant} className="gap-1">
                      <Icon className="h-3 w-3" aria-hidden="true" />
                      {badge.label}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
