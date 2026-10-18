"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, Download, Phone, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import type { CustomerDto } from "@/modules/catalog";
import type { CustomerActionResult } from "@/modules/catalog/api/actions";

type CustomerRow = CustomerDto & { outstandingMinor: string; overdueMinor: string };

export function ClientsListClient({
  structureId,
  structureName,
  currency,
  customers,
  canCreate,
  canExport,
  createCustomerAction,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
  customers: CustomerRow[];
  canCreate: boolean;
  canExport: boolean;
  createCustomerAction: (input: unknown) => Promise<CustomerActionResult>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSearch(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("search", value);
    } else {
      params.delete("search");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  async function handleCreate() {
    setPending(true);
    setError(null);
    const result = await createCustomerAction({ name, phone: phone || null });
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

  const exportHref = `/s/${structureId}/clients/export?${searchParams.toString()}`;

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
            <h1 className="truncate text-base font-semibold">{dict.clients.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
          {canExport && (
            <a
              href={exportHref}
              className="flex h-touch items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {dict.clients.exportCta}
            </a>
          )}
          {canCreate && (
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="flex h-touch items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {dict.clients.addClient}
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
              defaultValue={searchParams.get("search") ?? ""}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={dict.clients.searchPlaceholder}
              className="pl-9"
              aria-label={dict.clients.searchPlaceholder}
            />
          </div>
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.clients.title },
          ]}
        />

        {showForm && (
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <label className="mb-1 block text-sm font-medium" htmlFor="client-name">
              Nom
            </label>
            <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} className="mb-2" />
            <label className="mb-1 block text-sm font-medium" htmlFor="client-phone">
              {dict.clients.phoneLabel}
            </label>
            <Input id="client-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="mb-2" />
            {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending || name.trim().length === 0}
                onClick={handleCreate}
                className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                {dict.clients.createCta}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="h-touch rounded-md border border-border px-3 text-sm"
              >
                {dict.common.cancel}
              </button>
            </div>
          </div>
        )}

        <p className="mb-2 text-sm text-muted-foreground">
          {customers.length} {dict.clients.title.toLowerCase()}
        </p>

        {customers.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.clients.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {customers.map((customer) => (
              <li key={customer.id}>
                <a
                  href={`/s/${structureId}/clients/${customer.id}`}
                  className="flex items-center gap-3 p-4 hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{customer.name}</p>
                    {customer.phone && (
                      <p className="truncate text-sm text-muted-foreground">
                        <Phone className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                        {customer.phone}
                      </p>
                    )}
                  </div>
                  {Number(customer.outstandingMinor) > 0 ? (
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] text-muted-foreground">{dict.clients.balanceColumn}</p>
                      <p className="tabular-nums font-semibold">
                        {formatMoney(Number(customer.outstandingMinor), currency)}
                      </p>
                      {Number(customer.overdueMinor) > 0 && (
                        <p className="text-[11px] text-destructive">
                          {dict.clients.overdueColumn}: {formatMoney(Number(customer.overdueMinor), currency)}
                        </p>
                      )}
                    </div>
                  ) : (
                    <Badge variant="success" className="shrink-0">
                      {dict.clients.noBalance}
                    </Badge>
                  )}
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
