"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { dict } from "@/lib/i18n";
import type { SearchResultDto } from "@/modules/analytics";

const DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// GlobalSearch -- the app shell's quick search (Ctrl/Cmd+K). ONE Server
// Action call per debounced keystroke (never one call per section) --
// `searchAction` itself already fans out the five sections in PARALLEL
// inside a single `withTenantSession`, filtered by permission AND store
// at the SQL level (see analytics/application/global-search.ts). This
// component only renders whatever comes back -- an actor without
// `supplier:read` simply never sees a non-empty "Fournisseurs" section,
// because the server never put anything there.
// ---------------------------------------------------------------------------
export function GlobalSearch({
  structureId,
  searchAction,
}: {
  structureId: string;
  searchAction: (query: string) => Promise<SearchResultDto>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResultDto | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (query.trim().length < 2) {
      setResult(null);
      return;
    }
    setPending(true);
    const timer = setTimeout(() => {
      searchAction(query)
        .then(setResult)
        .finally(() => setPending(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open, searchAction]);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    setResult(null);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate text-left">{dict.search.placeholder}</span>
        <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] md:inline">
          {dict.search.shortcutHint}
        </kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center bg-foreground/40 px-4 pt-20">
          <button
            type="button"
            aria-label={dict.search.close}
            className="absolute inset-0"
            onClick={() => setOpen(false)}
          />
          <div className="relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={dict.search.placeholder}
                aria-label={dict.search.placeholder}
                className="h-12 flex-1 bg-transparent text-sm outline-none"
              />
              <button type="button" aria-label={dict.search.close} onClick={() => setOpen(false)} className="p-2">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {pending && <p className="px-2 py-3 text-sm text-muted-foreground">{dict.common.loading}</p>}
              {!pending && result && isEmptyResult(result) && (
                <p className="px-2 py-3 text-sm text-muted-foreground">{dict.search.noResults}</p>
              )}
              {!pending && result && (
                <>
                  <Section
                    label={dict.search.sectionProducts}
                    items={result.products.map((p) => ({
                      key: p.productId,
                      label: `${p.name} (${p.sku})`,
                      href: `/s/${structureId}/produits`,
                    }))}
                    go={go}
                  />
                  <Section
                    label={dict.search.sectionCustomers}
                    items={result.customers.map((c) => ({
                      key: c.customerId,
                      label: c.name,
                      href: `/s/${structureId}/clients/${c.customerId}`,
                    }))}
                    go={go}
                  />
                  <Section
                    label={dict.search.sectionSuppliers}
                    items={result.suppliers.map((s) => ({
                      key: s.supplierId,
                      label: s.name,
                      href: `/s/${structureId}/fournisseurs/${s.supplierId}`,
                    }))}
                    go={go}
                  />
                  <Section
                    label={dict.search.sectionSales}
                    items={result.sales.map((s) => ({
                      key: s.saleId,
                      label: `Ticket ${s.ticketNumber}`,
                      href: `/s/${structureId}/ventes/${s.saleId}`,
                    }))}
                    go={go}
                  />
                  <Section
                    label={dict.search.sectionTransfers}
                    items={result.transfers.map((t) => ({
                      key: t.transferId,
                      label: t.reference,
                      href: `/s/${structureId}/transferts`,
                    }))}
                    go={go}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function isEmptyResult(result: SearchResultDto): boolean {
  return (
    result.products.length === 0 &&
    result.customers.length === 0 &&
    result.suppliers.length === 0 &&
    result.sales.length === 0 &&
    result.transfers.length === 0
  );
}

function Section({
  label,
  items,
  go,
}: {
  label: string;
  items: Array<{ key: string; label: string; href: string }>;
  go: (href: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">{label}</p>
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => go(item.href)}
              className="flex w-full items-center rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
