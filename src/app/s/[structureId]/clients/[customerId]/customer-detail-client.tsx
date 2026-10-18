"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import type { CustomerDto } from "@/modules/catalog";
import type { SaleSummaryDto } from "@/modules/sales";
import type { RecordPaymentActionResult } from "@/modules/billing/api";

function formatDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

// "Encaisser" -- calls `billingService.recordPayment` UNCHANGED (via the
// thin Server Action) for ONE specific open sale at a time. A customer's
// receivable can span several sales; this form lets the cashier/accountant
// pick which sale the payment is against, instead of the UI inventing a
// second, undated "pay down the customer's balance" path.
function EncaisserForm({
  saleId,
  balanceMinor,
  currency,
  recordPaymentAction,
  onSuccess,
}: {
  saleId: string;
  balanceMinor: number;
  currency: SupportedCurrency;
  recordPaymentAction: (input: {
    saleId: string;
    amountMinor: string;
    method: "cash" | "mobile_money" | "bank_transfer" | "card" | "other";
    reference?: string | null;
    idempotencyKey: string;
  }) => Promise<RecordPaymentActionResult>;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState(String(balanceMinor));
  const [method, setMethod] = useState<"cash" | "mobile_money" | "bank_transfer" | "card" | "other">("cash");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function handleSubmit() {
    setPending(true);
    setError(null);
    const idempotencyKey = `${saleId}:${crypto.randomUUID()}`;
    const result = await recordPaymentAction({ saleId, amountMinor: amount, method, idempotencyKey });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    onSuccess();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {dict.clients.encaisserCta}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border p-3">
      <label className="mb-1 block text-xs font-medium" htmlFor={`amount-${saleId}`}>
        {dict.clients.encaisserAmountLabel}
      </label>
      <Input
        id={`amount-${saleId}`}
        type="number"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="mb-2"
      />
      <label className="mb-1 block text-xs font-medium" htmlFor={`method-${saleId}`}>
        {dict.clients.encaisserMethodLabel}
      </label>
      <select
        id={`method-${saleId}`}
        value={method}
        onChange={(e) => setMethod(e.target.value as typeof method)}
        className="mb-2 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="cash">{dict.pos.cash}</option>
        <option value="mobile_money">{dict.pos.mobileMoney}</option>
        <option value="bank_transfer">Virement</option>
        <option value="card">Carte</option>
        <option value="other">Autre</option>
      </select>
      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={handleSubmit}
          className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {dict.clients.encaisserSubmit}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-touch rounded-md border border-border px-3 text-sm">
          {dict.common.cancel}
        </button>
      </div>
    </div>
  );
}

export function CustomerDetailClient({
  structureId,
  structureName,
  currency,
  customer,
  sales,
  openSales,
  recordPaymentAction,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
  customer: CustomerDto;
  sales: SaleSummaryDto[];
  openSales: SaleSummaryDto[];
  recordPaymentAction: (input: {
    saleId: string;
    amountMinor: string;
    method: "cash" | "mobile_money" | "bank_transfer" | "card" | "other";
    reference?: string | null;
    idempotencyKey: string;
  }) => Promise<RecordPaymentActionResult>;
}) {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background pb-6">
      <header className="sticky top-0 z-30 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <a
            href={`/s/${structureId}/clients`}
            aria-label="Retour aux clients"
            className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </a>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{customer.name}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.clients.title, href: `/s/${structureId}/clients` },
            { label: customer.name },
          ]}
        />

        <section className="mb-4 rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">{dict.clients.detailTitle}</h2>
          {customer.phone && (
            <p className="text-sm text-muted-foreground">
              <Phone className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
              {customer.phone}
            </p>
          )}
          {customer.email && <p className="text-sm text-muted-foreground">{customer.email}</p>}
          {customer.creditLimitMinor && (
            <p className="text-sm text-muted-foreground">
              {dict.clients.creditLimitLabel}: {formatMoney(Number(customer.creditLimitMinor), currency)}
            </p>
          )}
          <Badge variant={customer.isActive ? "success" : "outline"} className="mt-2">
            {customer.isActive ? dict.clients.activeLabel : "Inactif"}
          </Badge>
        </section>

        {openSales.length > 0 && (
          <section className="mb-4">
            <h2 className="mb-2 text-sm font-semibold">{dict.clients.openSalesTitle}</h2>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {openSales.map((sale) => {
                const balance = Number(sale.totalMinor) - Number(sale.paidMinor);
                return (
                  <li key={sale.id} className="p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Ticket {sale.ticketNumber ?? "--"}</p>
                        <p className="text-xs text-muted-foreground">{formatDate(sale.confirmedAt)}</p>
                      </div>
                      <p className="tabular-nums font-semibold">{formatMoney(balance, currency)}</p>
                    </div>
                    <EncaisserForm
                      saleId={sale.id}
                      balanceMinor={balance}
                      currency={currency}
                      recordPaymentAction={recordPaymentAction}
                      onSuccess={() => router.refresh()}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-semibold">{dict.clients.salesHistoryTitle}</h2>
          {sales.length === 0 ? (
            <p className="text-sm text-muted-foreground">{dict.salesHistory.empty}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {sales.map((sale) => (
                <li key={sale.id}>
                  <a
                    href={`/s/${structureId}/ventes/${sale.id}`}
                    className="flex items-center justify-between gap-3 p-3 hover:bg-accent"
                  >
                    <div>
                      <p className="text-sm font-medium">Ticket {sale.ticketNumber ?? "--"}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(sale.confirmedAt)}</p>
                    </div>
                    <p className="tabular-nums font-semibold">{formatMoney(Number(sale.totalMinor), currency)}</p>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
