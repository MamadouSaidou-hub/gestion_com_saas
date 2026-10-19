"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import type { RecordPaymentActionResult } from "@/modules/billing/api";

export interface OpenSaleOption {
  id: string;
  ticketNumber: string | null;
  balanceMinor: number;
}

type PaymentMethod = "cash" | "mobile_money" | "bank_transfer" | "card" | "other";

// "Nouvel encaissement" -- calls `billingService.recordPayment` UNCHANGED
// (via the exact same Server Action the client detail screen already
// uses, `recordPaymentAction`), for ONE open sale picked from a plain
// list. No second money primitive is introduced here.
function EncaisserForm({
  sale,
  currency,
  recordPaymentAction,
  onSuccess,
}: {
  sale: OpenSaleOption;
  currency: SupportedCurrency;
  recordPaymentAction: (input: {
    saleId: string;
    amountMinor: string;
    method: PaymentMethod;
    reference?: string | null;
    idempotencyKey: string;
  }) => Promise<RecordPaymentActionResult>;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState(String(sale.balanceMinor));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function handleSubmit() {
    setPending(true);
    setError(null);
    const idempotencyKey = `${sale.id}:${crypto.randomUUID()}`;
    const result = await recordPaymentAction({ saleId: sale.id, amountMinor: amount, method, idempotencyKey });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    onSuccess();
  }

  return (
    <li className="p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Ticket {sale.ticketNumber ?? "--"}</p>
        <p className="tabular-nums font-semibold">{formatMoney(sale.balanceMinor, currency)}</p>
      </div>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {dict.clients.encaisserCta}
        </button>
      ) : (
        <div className="mt-2 rounded-md border border-border p-3">
          <label className="mb-1 block text-xs font-medium" htmlFor={`amount-${sale.id}`}>
            {dict.clients.encaisserAmountLabel}
          </label>
          <Input
            id={`amount-${sale.id}`}
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mb-2"
          />
          <label className="mb-1 block text-xs font-medium" htmlFor={`method-${sale.id}`}>
            {dict.clients.encaisserMethodLabel}
          </label>
          <select
            id={`method-${sale.id}`}
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
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
      )}
    </li>
  );
}

export function NewPaymentSection({
  structureId,
  currency,
  openSales,
  recordPaymentAction,
}: {
  structureId: string;
  currency: SupportedCurrency;
  openSales: OpenSaleOption[];
  recordPaymentAction: (input: {
    saleId: string;
    amountMinor: string;
    method: PaymentMethod;
    reference?: string | null;
    idempotencyKey: string;
  }) => Promise<RecordPaymentActionResult>;
}) {
  const router = useRouter();
  void structureId;

  if (openSales.length === 0) {
    return <p className="text-sm text-muted-foreground">{dict.treasury.newPaymentEmpty}</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
      {openSales.map((sale) => (
        <EncaisserForm
          key={sale.id}
          sale={sale}
          currency={currency}
          recordPaymentAction={recordPaymentAction}
          onSuccess={() => router.refresh()}
        />
      ))}
    </ul>
  );
}
