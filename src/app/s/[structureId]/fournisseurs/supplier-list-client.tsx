"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Phone, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { MockDataBanner } from "@/components/mock-data-banner";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { MOCK_SUPPLIERS } from "./mock-suppliers";

export function SupplierListClient({
  structureId,
  structureName,
  currency,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MOCK_SUPPLIERS;
    return MOCK_SUPPLIERS.filter(
      (s) => s.name.toLowerCase().includes(q) || s.contactName.toLowerCase().includes(q)
    );
  }, [query]);

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
            <h1 className="truncate text-base font-semibold">{dict.suppliers.title}</h1>
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
              placeholder={dict.suppliers.searchPlaceholder}
              className="pl-9"
              aria-label={dict.suppliers.searchPlaceholder}
            />
          </div>
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.nav.captionGestion },
            { label: dict.suppliers.title },
          ]}
        />
        <MockDataBanner />
        <p className="mb-2 text-sm text-muted-foreground">
          {results.length} {dict.suppliers.title.toLowerCase()}
        </p>

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.suppliers.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {results.map((supplier) => (
              <li key={supplier.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{supplier.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {supplier.contactName}
                    <span className="mx-1" aria-hidden="true">
                      &middot;
                    </span>
                    <a
                      href={`tel:${supplier.phone}`}
                      className="inline-flex items-center gap-1 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                      {supplier.phone}
                    </a>
                  </p>
                </div>
                {supplier.balanceOwed > 0 ? (
                  // Plain foreground, not `text-warning` -- amber is reserved for
                  // stock alerts only (design direction); an amount owed to a
                  // supplier is informational, not a stock-attention signal.
                  <div className="shrink-0 text-right">
                    <p className="text-[11px] text-muted-foreground">{dict.suppliers.balanceOwed}</p>
                    <p className="tabular-nums font-semibold">{formatMoney(supplier.balanceOwed, currency)}</p>
                  </div>
                ) : (
                  <Badge variant="success" className="shrink-0">
                    {dict.suppliers.noBalance}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
