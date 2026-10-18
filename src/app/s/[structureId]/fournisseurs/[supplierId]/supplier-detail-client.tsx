"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Phone } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import type { SupplierDto } from "@/modules/catalog";
import type {
  DeliveryDto,
  SupplierDebtDto,
  SupplierPaymentMethod,
  RecordDeliveryInput,
  RecordSupplierPaymentInput,
} from "@/modules/purchasing";
import type { RebateProgressDto } from "@/modules/rebates";

type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

function statusLabel(status: DeliveryDto["paymentStatus"]): string {
  if (status === "unpaid") return dict.purchasing.statusUnpaid;
  if (status === "partial") return dict.purchasing.statusPartial;
  return dict.purchasing.statusPaid;
}

export function SupplierDetailClient({
  structureId,
  structureName,
  currency,
  supplier,
  debt,
  deliveries,
  products,
  rebateProgress,
  defaultWarehouseId,
  canRecordDelivery,
  canRecordPayment,
  canVoidPayment: _canVoidPayment,
  canVerifyTier,
  recordDeliveryAction,
  recordSupplierPaymentAction,
  voidSupplierPaymentAction: _voidSupplierPaymentAction,
  verifyRebateTierAction,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
  supplier: SupplierDto;
  debt: SupplierDebtDto;
  deliveries: DeliveryDto[];
  products: { id: string; name: string; sku: string }[];
  rebateProgress: RebateProgressDto | null;
  defaultWarehouseId: string | null;
  canRecordDelivery: boolean;
  canRecordPayment: boolean;
  canVoidPayment: boolean;
  canVerifyTier: boolean;
  recordDeliveryAction: (input: RecordDeliveryInput) => Promise<ActionResult<DeliveryDto>>;
  recordSupplierPaymentAction: (input: RecordSupplierPaymentInput) => Promise<ActionResult<unknown>>;
  voidSupplierPaymentAction: (paymentId: string) => Promise<ActionResult<unknown>>;
  verifyRebateTierAction: () => Promise<ActionResult<unknown>>;
}) {
  const router = useRouter();
  const [showDeliveryForm, setShowDeliveryForm] = useState(false);
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");
  const [unitCostMinor, setUnitCostMinor] = useState("0");
  const [showPayForm, setShowPayForm] = useState(false);
  const [payAmount, setPayAmount] = useState("0");
  const [payMethod, setPayMethod] = useState<SupplierPaymentMethod>("cash");
  const [payDeliveryId, setPayDeliveryId] = useState<string | undefined>(deliveries[0]?.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleRecordDelivery() {
    setPending(true);
    setError(null);
    if (!defaultWarehouseId) {
      setPending(false);
      setError("Aucun magasin actif pour recevoir cette livraison.");
      return;
    }
    const result = await recordDeliveryAction({
      idempotencyKey: `delivery:${supplier.id}:${crypto.randomUUID()}`,
      supplierId: supplier.id,
      warehouseId: defaultWarehouseId,
      currencyCode: currency,
      lines: [{ productId, quantity, unitCostMinor }],
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setShowDeliveryForm(false);
    setNotice(dict.purchasing.recordDeliverySuccess);
    router.refresh();
  }

  async function handleRecordPayment() {
    setPending(true);
    setError(null);
    const result = await recordSupplierPaymentAction({
      idempotencyKey: `supplier-payment:${supplier.id}:${crypto.randomUUID()}`,
      supplierId: supplier.id,
      deliveryId: payDeliveryId ?? null,
      amountMinor: payAmount,
      method: payMethod,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setShowPayForm(false);
    setNotice(dict.purchasing.recordPaymentSuccess);
    router.refresh();
  }

  async function handleVerifyTier() {
    setPending(true);
    setError(null);
    const result = await verifyRebateTierAction();
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  const debtAmount = Number(debt.debtMinor);

  return (
    <div className="min-h-screen bg-background pb-6">
      <header className="sticky top-0 z-30 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <a
            href={`/s/${structureId}/fournisseurs`}
            aria-label="Retour aux fournisseurs"
            className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{supplier.name}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.nav.captionGestion },
            { label: dict.suppliers.title, href: `/s/${structureId}/fournisseurs` },
            { label: supplier.name },
          ]}
        />

        {supplier.phone && (
          <p className="mb-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              {supplier.phone}
            </span>
          </p>
        )}

        <div className="mb-4 rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{dict.purchasing.debtLabel}</p>
          <p className="text-xl font-semibold tabular-nums">{formatMoney(debtAmount, currency)}</p>
        </div>

        {notice && <p className="mb-3 text-sm text-success-foreground">{notice}</p>}
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        <div className="mb-4 flex gap-2">
          {canRecordDelivery && (
            <button
              type="button"
              onClick={() => setShowDeliveryForm((v) => !v)}
              className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {dict.purchasing.newDelivery}
            </button>
          )}
          {canRecordPayment ? (
            <button
              type="button"
              onClick={() => setShowPayForm((v) => !v)}
              disabled={deliveries.length === 0}
              className="h-touch rounded-md border border-border px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              {dict.purchasing.payButton}
            </button>
          ) : (
            <span className="flex h-touch items-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground">
              {dict.purchasing.payButtonUnavailable}
            </span>
          )}
        </div>

        {showDeliveryForm && (
          <div className="mb-4 rounded-md border border-border p-3">
            <h2 className="mb-2 text-sm font-semibold">{dict.purchasing.newDeliveryTitle}</h2>
            <label className="mb-1 block text-xs font-medium" htmlFor="delivery-product">
              {dict.purchasing.productLabel}
            </label>
            <select
              id="delivery-product"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="mb-2 h-touch w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </select>
            <label className="mb-1 block text-xs font-medium" htmlFor="delivery-qty">
              {dict.purchasing.quantityLabel}
            </label>
            <Input id="delivery-qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="mb-2" />
            <label className="mb-1 block text-xs font-medium" htmlFor="delivery-cost">
              {dict.purchasing.unitCostLabel}
            </label>
            <Input
              id="delivery-cost"
              value={unitCostMinor}
              onChange={(e) => setUnitCostMinor(e.target.value)}
              className="mb-2"
            />
            <button
              type="button"
              disabled={pending || !productId}
              onClick={handleRecordDelivery}
              className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {dict.purchasing.recordDeliveryCta}
            </button>
          </div>
        )}

        {showPayForm && (
          <div className="mb-4 rounded-md border border-border p-3">
            <label className="mb-1 block text-xs font-medium" htmlFor="pay-delivery">
              {dict.purchasing.deliveryReference}
            </label>
            <select
              id="pay-delivery"
              value={payDeliveryId}
              onChange={(e) => setPayDeliveryId(e.target.value)}
              className="mb-2 h-touch w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {deliveries.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.reference} -- {formatMoney(Number(d.totalMinor) - Number(d.paidMinor), currency)} restant
                </option>
              ))}
            </select>
            <label className="mb-1 block text-xs font-medium" htmlFor="pay-amount">
              {dict.purchasing.payAmountLabel}
            </label>
            <Input id="pay-amount" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} className="mb-2" />
            <label className="mb-1 block text-xs font-medium" htmlFor="pay-method">
              {dict.purchasing.payMethodLabel}
            </label>
            <select
              id="pay-method"
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value as SupplierPaymentMethod)}
              className="mb-2 h-touch w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="cash">Espèces</option>
              <option value="mobile_money">Mobile money</option>
              <option value="bank_transfer">Virement</option>
              <option value="card">Carte</option>
              <option value="other">Autre</option>
            </select>
            <button
              type="button"
              disabled={pending}
              onClick={handleRecordPayment}
              className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {dict.purchasing.recordPaymentCta}
            </button>
          </div>
        )}

        {rebateProgress && (
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">{dict.rebates.title}</h2>
            <p className="mb-2 text-xs text-muted-foreground">{dict.rebates.informationalBanner}</p>
            <p className="text-sm">
              {dict.rebates.unitsThisCycle}: <span className="tabular-nums font-medium">{rebateProgress.countedQty}</span>
            </p>
            <p className="text-sm">
              {rebateProgress.tierReached ? (
                <>
                  {dict.rebates.tierReached}: {rebateProgress.tierReached.thresholdQty} --{" "}
                  {dict.rebates.projectedRebate}:{" "}
                  <span className="font-medium">
                    {formatMoney(Number(rebateProgress.projectedRebateMinor ?? "0"), currency)}
                  </span>
                </>
              ) : (
                dict.rebates.noTierReached
              )}
            </p>
            {rebateProgress.nextTier && (
              <p className="text-xs text-muted-foreground">
                {rebateProgress.unitsToNextTier} {dict.rebates.nextTierIn}
              </p>
            )}
            {canVerifyTier && (
              <button
                type="button"
                onClick={handleVerifyTier}
                disabled={pending}
                className="mt-2 h-touch rounded-md border border-border px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
              >
                {dict.rebates.verifyTierCta}
              </button>
            )}
          </div>
        )}

        <h2 className="mb-2 text-sm font-semibold">{dict.purchasing.deliveriesTitle}</h2>
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{dict.purchasing.noDeliveries}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {deliveries.map((d) => (
              <li key={d.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{d.reference}</p>
                  <p className="text-xs text-muted-foreground">{statusLabel(d.paymentStatus)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular-nums font-semibold">{formatMoney(Number(d.totalMinor), currency)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
