"use client";

import { useMemo, useState } from "react";
import { ArrowDownCircle, ArrowLeft, ArrowUpCircle, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { dict } from "@/lib/i18n";
import { MockDataBanner } from "@/components/mock-data-banner";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { MOCK_STOCK_MOVEMENTS } from "./mock-stock-movements";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function StockMovementsClient({
  structureId,
  structureName,
  canRecordMovement,
}: {
  structureId: string;
  structureName: string;
  canRecordMovement: boolean;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MOCK_STOCK_MOVEMENTS;
    return MOCK_STOCK_MOVEMENTS.filter((m) => m.productName.toLowerCase().includes(q));
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
            <h1 className="truncate text-base font-semibold">{dict.stocks.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={dict.stocks.searchPlaceholder}
              className="pl-9"
              aria-label={dict.stocks.searchPlaceholder}
            />
          </div>
          {canRecordMovement && (
            <button
              type="button"
              disabled
              title="Bientôt disponible"
              className="flex h-touch shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-3 text-sm font-medium text-muted-foreground"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{dict.stocks.recordMovement}</span>
            </button>
          )}
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.nav.captionPilotage },
            { label: dict.stocks.title },
          ]}
        />
        <MockDataBanner />
        <p className="mb-2 text-sm text-muted-foreground">{dict.stocks.subtitle}</p>

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.stocks.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {results.map((movement) => {
              const isIn = movement.direction === "in";
              return (
                <li key={movement.id} className="flex items-center gap-3 p-4">
                  {/* In/out distinguished by icon direction + badge variant,
                      NOT by amber/red (those are reserved for stock-low
                      alerts and destructive actions respectively). Green
                      (success) for "in" reads as replenishment; neutral
                      secondary for "out" since outgoing stock from a normal
                      sale is not itself an alert condition. */}
                  {isIn ? (
                    <ArrowDownCircle className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <ArrowUpCircle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{movement.productName}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {movement.reason}
                      <span className="mx-1" aria-hidden="true">
                        &middot;
                      </span>
                      {formatDateTime(movement.occurredOn)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge variant={isIn ? "success" : "secondary"} className="tabular-nums">
                      {isIn ? "+" : "-"}
                      {movement.quantity} {movement.unit}
                      {movement.quantity !== 1 ? "s" : ""}
                    </Badge>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {dict.stocks.resultingStock}: {movement.resultingStock}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <a
          href={`/s/${structureId}/produits`}
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          {dict.stocks.seeCatalog}
        </a>
      </main>
    </div>
  );
}
