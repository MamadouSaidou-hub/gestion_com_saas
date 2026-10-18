"use client";

import { useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, Clock, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import type { InvoiceDto } from "@/modules/billing";

export type InvoiceRow = InvoiceDto & { customerName: string };

// UI-level status bucket, derived from the REAL invoice status
// (draft/issued/paid/partially_paid/cancelled) -- never a separate mock
// enum. "pending" covers issued + partially_paid (not yet fully settled,
// not overdue); "overdue" additionally requires a due date in the past.
type UiStatus = "paid" | "pending" | "overdue" | "cancelled";

function toUiStatus(invoice: InvoiceRow): UiStatus {
  if (invoice.status === "cancelled") return "cancelled";
  if (invoice.status === "paid") return "paid";
  if (invoice.dueAt && new Date(invoice.dueAt) < new Date()) return "overdue";
  return "pending";
}

const STATUS_FILTERS: Array<{ value: UiStatus | "all"; label: string }> = [
  { value: "all", label: dict.invoices.filterAll },
  { value: "pending", label: dict.invoices.statusPending },
  { value: "overdue", label: dict.invoices.statusOverdue },
  { value: "paid", label: dict.invoices.statusPaid },
];

function statusBadge(status: UiStatus) {
  switch (status) {
    case "paid":
      return { variant: "success" as const, icon: CheckCircle2, label: dict.invoices.statusPaid };
    case "pending":
      return { variant: "secondary" as const, icon: Clock, label: dict.invoices.statusPending };
    case "overdue":
      return { variant: "outline" as const, icon: AlertCircle, label: dict.invoices.statusOverdue };
    case "cancelled":
      return { variant: "outline" as const, icon: AlertCircle, label: "Annulée" };
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function InvoiceListClient({
  structureId,
  structureName,
  currency,
  invoices,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
  invoices: InvoiceRow[];
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<UiStatus | "all">("all");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return invoices.filter((invoice) => {
      const status = toUiStatus(invoice);
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (!q) return true;
      return invoice.customerName.toLowerCase().includes(q) || invoice.docNumber.toLowerCase().includes(q);
    });
  }, [query, statusFilter, invoices]);

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
        <p className="mb-2 text-sm text-muted-foreground">
          {results.length} {dict.invoices.title.toLowerCase()}
        </p>

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.invoices.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {results.map((invoice) => {
              const badge = statusBadge(toUiStatus(invoice));
              const Icon = badge.icon;
              return (
                <li key={invoice.id}>
                  <a
                    href={invoice.saleId ? `/s/${structureId}/ventes/${invoice.saleId}` : "#"}
                    className="flex items-center gap-3 p-4 hover:bg-accent"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{invoice.customerName}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {invoice.docNumber}
                        <span className="mx-1" aria-hidden="true">
                          &middot;
                        </span>
                        {dict.invoices.issuedOn} {formatDate(invoice.issuedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <p className="tabular-nums font-semibold">{formatMoney(Number(invoice.totalMinor), currency)}</p>
                      <Badge variant={badge.variant} className="gap-1">
                        <Icon className="h-3 w-3" aria-hidden="true" />
                        {badge.label}
                      </Badge>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
