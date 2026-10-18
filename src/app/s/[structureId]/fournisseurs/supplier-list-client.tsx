"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Phone, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import type { SupplierDto } from "@/modules/catalog";
import type { SupplierActionResult } from "@/modules/catalog/api/actions";

type SupplierRow = SupplierDto & { debtMinor: string };

export function SupplierListClient({
  structureId,
  structureName,
  currency,
  suppliers,
  canCreate,
  createSupplierAction,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
  suppliers: SupplierRow[];
  canCreate: boolean;
  createSupplierAction: (input: unknown) => Promise<SupplierActionResult>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((s) => s.name.toLowerCase().includes(q));
  }, [query, suppliers]);

  async function handleCreate() {
    setPending(true);
    setError(null);
    const result = await createSupplierAction({ name, phone: phone || null });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setShowForm(false);
    setName("");
    setPhone("");
    router.refresh();
  }

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
            <h1 className="truncate text-base font-semibold">{dict.suppliers.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              aria-label={dict.common.create}
              className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
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

        {showForm && (
          <div className="mb-3 rounded-md border border-border p-3">
            <label className="mb-1 block text-xs font-medium" htmlFor="supplier-name">
              Nom
            </label>
            <Input id="supplier-name" value={name} onChange={(e) => setName(e.target.value)} className="mb-2" />
            <label className="mb-1 block text-xs font-medium" htmlFor="supplier-phone">
              Téléphone
            </label>
            <Input id="supplier-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="mb-2" />
            {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
            <button
              type="button"
              disabled={pending || !name.trim()}
              onClick={handleCreate}
              className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {dict.common.create}
            </button>
          </div>
        )}

        <p className="mb-2 text-sm text-muted-foreground">
          {results.length} {dict.suppliers.title.toLowerCase()}
        </p>

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.suppliers.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {results.map((supplier) => {
              const debt = Number(supplier.debtMinor);
              return (
                <li key={supplier.id}>
                  <a
                    href={`/s/${structureId}/fournisseurs/${supplier.id}`}
                    className="flex items-center gap-3 p-4 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{supplier.name}</p>
                      {supplier.phone && (
                        <p className="truncate text-sm text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                            {supplier.phone}
                          </span>
                        </p>
                      )}
                    </div>
                    {debt > 0 ? (
                      <div className="shrink-0 text-right">
                        <p className="text-[11px] text-muted-foreground">{dict.suppliers.balanceOwed}</p>
                        <p className="tabular-nums font-semibold">{formatMoney(debt, currency)}</p>
                      </div>
                    ) : (
                      <Badge variant="success" className="shrink-0">
                        {dict.suppliers.noBalance}
                      </Badge>
                    )}
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
