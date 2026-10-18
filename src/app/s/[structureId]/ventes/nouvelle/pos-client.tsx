"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Minus, Plus, Search, ShoppingCart, Trash2, X, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import {
  enqueueSale,
  updateSale,
  listQueuedSales,
  removeSale,
  buildRetryBatch,
  scopeKeyFor,
  gcExpiredAcrossScopes,
  type QueuedSale,
} from "@/lib/offline-sales-queue";
import { confirmSaleAction, type ConfirmSaleActionInput, type ConfirmSaleActionResult } from "@/modules/sales/api/actions";

export interface RealProduct {
  id: string;
  sku: string;
  name: string;
  priceMinor: string; // DTO money string -- XOF/GNF exponent 0, safe to Number() for display
  quantity: string; // numeric(18,4) string -- stock on hand
  lowStockThreshold: string | null;
  categoryId: string | null;
  categoryName: string | null;
}

const NO_CATEGORY_KEY = "__none__";

interface CartLine {
  product: RealProduct;
  quantity: number;
}

type PaymentMode = "now" | "credit";
type PaymentMethod = "cash" | "mobile_money" | "bank_transfer";

const PAYMENT_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "cash", label: dict.pos.cash },
  { id: "mobile_money", label: dict.pos.mobileMoney },
  { id: "bank_transfer", label: "Virement" },
];

// Generates the idempotency key ONCE, at the moment the cashier taps
// "Encaisser" -- see offline-sales-queue.ts's header comment for why this
// must never be called again for the same sale attempt.
function generateIdempotencyKey(): string {
  return `pos-${crypto.randomUUID()}`;
}

export function PosClient({
  structureId,
  userId,
  structureName,
  currency,
  currencyCode,
  warehouseId,
  products,
}: {
  structureId: string;
  userId: string;
  structureName: string;
  currency: SupportedCurrency;
  currencyCode: string;
  warehouseId: string | null;
  products: RealProduct[];
  canRecordPayment: boolean;
}) {
  // M4 fix (security-reviewer, Medium): scopes the IndexedDB queue by
  // structure+user so a shared till switching cashiers never sees (or
  // submits under the wrong identity) another cashier's pending sale.
  const scopeKey = scopeKeyFor(structureId, userId);
  const [query, setQuery] = useState("");
  const [activeCategoryKey, setActiveCategoryKey] = useState<string | "all">("all");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("now");
  const [customerName, setCustomerName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedSale<ConfirmSaleActionInput>[]>([]);
  const submittingRef = useRef(false);

  // Rayon chips -- built straight off the products the POS already has
  // (categoryName/categoryId, joined server-side), no extra query. Order
  // follows first appearance in the catalog, which in practice tracks
  // however the shopkeeper created their rayons.
  const categoryChips = useMemo(() => {
    const seen = new Map<string, string>();
    let hasUncategorized = false;
    for (const p of products) {
      if (p.categoryId) {
        if (!seen.has(p.categoryId)) seen.set(p.categoryId, p.categoryName ?? "");
      } else {
        hasUncategorized = true;
      }
    }
    const chips = Array.from(seen.entries()).map(([id, name]) => ({ key: id, label: name }));
    if (hasUncategorized) {
      chips.push({ key: NO_CATEGORY_KEY, label: dict.pos.categoryNoneChip });
    }
    return chips;
  }, [products]);

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = products;
    if (activeCategoryKey !== "all") {
      list = list.filter((p) =>
        activeCategoryKey === NO_CATEGORY_KEY ? !p.categoryId : p.categoryId === activeCategoryKey
      );
    }
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
  }, [products, query, activeCategoryKey]);

  const lines: CartLine[] = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, quantity]) => {
          const product = products.find((p) => p.id === id);
          return product ? { product, quantity } : null;
        })
        .filter((l): l is CartLine => l !== null),
    [cart, products]
  );

  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const total = lines.reduce((sum, l) => sum + l.quantity * Number(l.product.priceMinor), 0);

  // --- Retry queue plumbing -------------------------------------------
  const refreshQueue = useCallback(async () => {
    const all = await listQueuedSales<ConfirmSaleActionInput>(scopeKey);
    setQueue(all.sort((a, b) => b.createdAt - a.createdAt));
  }, [scopeKey]);

  const submit = useCallback(
    async (entry: QueuedSale<ConfirmSaleActionInput>) => {
      let result: ConfirmSaleActionResult;
      try {
        result = await confirmSaleAction(structureId, entry.payload);
      } catch {
        // Network/unexpected failure -- leave the entry `pending`. The
        // SAME idempotencyKey (already stored, never regenerated) will
        // be resent on the next retry pass.
        await refreshQueue();
        return;
      }
      if (result.ok) {
        await updateSale(entry.idempotencyKey, {
          status: "confirmed",
          ticketNumber: result.sale.ticketNumber,
          replayed: result.sale.replayed,
        });
      } else if (result.retryable) {
        // Stays `pending` -- retried later, same key.
      } else {
        await updateSale(entry.idempotencyKey, { status: "error", errorMessage: result.message });
      }
      await refreshQueue();
    },
    [structureId, refreshQueue]
  );

  const retryPending = useCallback(async () => {
    const all = await listQueuedSales<ConfirmSaleActionInput>(scopeKey);
    const { toRetry, toExpire } = buildRetryBatch(all, Date.now());
    for (const entry of toExpire) {
      await updateSale(entry.idempotencyKey, { status: "expired" });
    }
    for (const entry of toRetry) {
      await submit(entry);
    }
    if (toExpire.length > 0) {
      await refreshQueue();
    }
  }, [submit, refreshQueue, scopeKey]);

  useEffect(() => {
    // L-c fix (security-reviewer follow-up): sweeps EVERY scope's expired
    // entries once on mount -- not just this session's own (that's what
    // `retryPending`/`buildRetryBatch` already do, scoped) -- so a shared
    // till doesn't accumulate another cashier's stale carts/customer
    // names forever just because nobody signed in as THAT cashier again
    // to trigger their own expiry sweep.
    gcExpiredAcrossScopes();
    refreshQueue();
    retryPending();
    const onOnline = () => retryPending();
    window.addEventListener("online", onOnline);
    const interval = setInterval(retryPending, 20_000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Confirm sale ------------------------------------------------------
  async function confirmSale() {
    if (submittingRef.current || lines.length === 0 || !warehouseId) {
      return;
    }
    if (paymentMode === "credit" && customerName.trim().length === 0) {
      setFormError(dict.pos.customerNameRequired);
      return;
    }
    setFormError(null);
    submittingRef.current = true;

    // Generated ONCE, right here -- never regenerated on retry.
    const idempotencyKey = generateIdempotencyKey();
    const payload: ConfirmSaleActionInput = {
      idempotencyKey,
      warehouseId,
      currencyCode,
      customerName: paymentMode === "credit" ? customerName.trim() : null,
      lines: lines.map((l) => ({ productId: l.product.id, quantity: String(l.quantity) })),
      // H2 fix (security-reviewer, High): `full: true` tells the SERVER
      // to use its own TTC total -- the client only ever computes an HT
      // display total (`total` above), which falls short of the real
      // total the moment VAT > 0 and would otherwise misroute a "pay in
      // full" cash sale into the credit branch (refused for lack of a
      // customer on every VAT-registered shop).
      payment: paymentMode === "now" ? { method: paymentMethod, full: true } : null,
    };

    const entry: QueuedSale<ConfirmSaleActionInput> = {
      idempotencyKey,
      scopeKey,
      payload,
      createdAt: Date.now(),
      status: "pending",
    };
    await enqueueSale(entry);
    await refreshQueue();

    // Optimistic UI: clear the cart immediately, but the queue panel
    // below keeps this sale VISIBLY marked "en attente de confirmation"
    // until the server actually acknowledges it -- the cashier is never
    // led to believe an unconfirmed sale is settled.
    setCart({});
    setCartOpen(false);
    setCustomerName("");
    submittingRef.current = false;

    await submit(entry);
  }

  async function retryOne(entry: QueuedSale<ConfirmSaleActionInput>) {
    await updateSale(entry.idempotencyKey, { status: "pending" });
    await refreshQueue();
    const refreshed = (await listQueuedSales<ConfirmSaleActionInput>(scopeKey)).find(
      (e) => e.idempotencyKey === entry.idempotencyKey
    );
    if (refreshed) {
      await submit(refreshed);
    }
  }

  async function discardOne(idempotencyKey: string) {
    await removeSale(idempotencyKey);
    await refreshQueue();
  }

  const pendingOrAttentionCount = queue.filter((e) => e.status !== "confirmed").length;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
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
            <h1 className="truncate text-base font-semibold">{dict.pos.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
        </div>
        <div className="relative mt-3">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={dict.pos.searchPlaceholder}
            className="pl-9"
            aria-label={dict.pos.searchPlaceholder}
          />
        </div>

        {categoryChips.length > 0 && (
          <div className="-mb-1 mt-2 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label={dict.categories.title}>
            <button
              type="button"
              role="tab"
              aria-selected={activeCategoryKey === "all"}
              onClick={() => setActiveCategoryKey("all")}
              className={cn(
                "flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                activeCategoryKey === "all"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background text-foreground hover:bg-accent"
              )}
            >
              {dict.pos.categoryAllChip}
            </button>
            {categoryChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                role="tab"
                aria-selected={activeCategoryKey === chip.key}
                onClick={() => setActiveCategoryKey(chip.key)}
                className={cn(
                  "flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  activeCategoryKey === chip.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background text-foreground hover:bg-accent"
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* Retry queue panel -- visible, never hidden, never silently settled. */}
      {pendingOrAttentionCount > 0 && (
        <div className="border-b border-border bg-muted/30 px-4 py-2">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{dict.pos.queueTitle}</p>
          <ul className="space-y-1.5">
            {queue
              .filter((e) => e.status !== "confirmed" || Date.now() - e.createdAt < 10_000)
              .map((entry) => (
                <li
                  key={entry.idempotencyKey}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                >
                  {entry.status === "pending" && (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                      {dict.pos.confirmSending}
                    </span>
                  )}
                  {entry.status === "confirmed" && (
                    <span className="flex items-center gap-2 text-success">
                      <Check className="h-4 w-4" aria-hidden="true" />
                      {entry.replayed ? dict.pos.confirmReplayed : dict.pos.confirmConfirmed} #{entry.ticketNumber}
                    </span>
                  )}
                  {entry.status === "error" && (
                    <>
                      <span className="flex items-center gap-2 text-destructive">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        {dict.pos.confirmError}: {entry.errorMessage}
                      </span>
                      <span className="flex gap-2">
                        <button type="button" onClick={() => retryOne(entry)} className="font-medium text-primary hover:underline">
                          {dict.pos.retryAction}
                        </button>
                        <button type="button" onClick={() => discardOne(entry.idempotencyKey)} className="font-medium text-muted-foreground hover:underline">
                          {dict.pos.discardAction}
                        </button>
                      </span>
                    </>
                  )}
                  {entry.status === "expired" && (
                    <>
                      <span className="flex items-center gap-2 text-warning">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        {dict.pos.confirmExpired}
                      </span>
                      <button type="button" onClick={() => discardOne(entry.idempotencyKey)} className="font-medium text-muted-foreground hover:underline">
                        {dict.pos.discardAction}
                      </button>
                    </>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Catalog */}
      <main className="flex-1 px-4 py-3 pb-28">
        {filteredCatalog.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.pos.emptyCatalog}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {filteredCatalog.map((product) => {
              const stock = Number(product.quantity);
              const threshold = product.lowStockThreshold !== null ? Number(product.lowStockThreshold) : null;
              const quantityInCart = cart[product.id] ?? 0;
              const outOfStock = stock <= 0;
              const lowStock = !outOfStock && threshold !== null && stock <= threshold;
              const addOne = () =>
                setCart((prev) => {
                  if (stock <= (prev[product.id] ?? 0)) return prev;
                  return { ...prev, [product.id]: (prev[product.id] ?? 0) + 1 };
                });
              const removeOne = () =>
                setCart((prev) => {
                  const next = (prev[product.id] ?? 0) - 1;
                  if (next <= 0) {
                    const { [product.id]: _removed, ...rest } = prev;
                    return rest;
                  }
                  return { ...prev, [product.id]: next };
                });
              return (
                <li key={product.id}>
                  <div
                    className={cn(
                      "flex w-full flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm transition-colors",
                      quantityInCart > 0 && "border-primary ring-1 ring-primary/30"
                    )}
                  >
                    <button
                      type="button"
                      onClick={addOne}
                      disabled={outOfStock}
                      className={cn(
                        "flex w-full flex-col items-start gap-1.5 text-left",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        "focus-visible:outline-2 focus-visible:outline-ring"
                      )}
                    >
                      <span className="text-sm font-medium leading-snug">{product.name}</span>
                      <span className="tabular-nums text-sm font-semibold text-foreground">
                        {formatMoney(Number(product.priceMinor), currency)}
                      </span>
                      {outOfStock ? (
                        <Badge variant="destructive">{dict.pos.outOfStockBadge}</Badge>
                      ) : lowStock ? (
                        <Badge variant="warning">{dict.pos.lowStockBadge}</Badge>
                      ) : null}
                    </button>

                    {/* Inline stepper -- quantity adjustable right here,
                        no need to open the cart sheet for the common case
                        of "one more" / "one less" at speed. */}
                    {quantityInCart > 0 && (
                      <div className="flex items-center justify-between gap-1 rounded-md bg-primary/10 px-1.5 py-1">
                        <button
                          type="button"
                          aria-label={dict.pos.quantityStepperDecrease}
                          onClick={removeOne}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <Minus className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <span className="text-sm font-semibold tabular-nums text-primary">{quantityInCart}</span>
                        <button
                          type="button"
                          aria-label={dict.pos.quantityStepperIncrease}
                          onClick={addOne}
                          disabled={outOfStock || quantityInCart >= stock}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {/* Running total + "Encaisser" stay on screen the instant the cart
          has something in it -- the cashier never HAS to open the full
          cart sheet for the common "pay now" case; opening it is only
          needed to change payment method or switch to a credit sale. */}
      {itemCount > 0 && !cartOpen && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-stretch gap-2 bg-primary px-3 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] text-primary-foreground shadow-[0_-2px_8px_rgba(0,0,0,0.12)]">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            aria-label={dict.pos.viewCartCta}
            className="flex min-w-0 flex-1 flex-col items-start justify-center rounded-md px-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="flex items-center gap-1.5 text-xs opacity-90">
              <ShoppingCart className="h-4 w-4" aria-hidden="true" />
              {itemCount} {dict.pos.itemsInCart}
            </span>
            <span className="text-lg font-bold tabular-nums">{formatMoney(total, currency)}</span>
          </button>
          <Button
            size="lg"
            variant="success"
            className="shrink-0"
            onClick={() => (paymentMode === "now" ? confirmSale() : setCartOpen(true))}
          >
            {dict.pos.checkoutNow}
          </Button>
        </div>
      )}

      {cartOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">{dict.pos.cartTitle}</h2>
            <button
              type="button"
              onClick={() => setCartOpen(false)}
              aria-label="Fermer le panier"
              className="flex h-touch w-touch items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {lines.length === 0 ? (
              <p className="mt-8 text-center text-sm text-muted-foreground">{dict.pos.cartEmpty}</p>
            ) : (
              <ul className="divide-y divide-border">
                {lines.map(({ product, quantity }) => (
                  <li key={product.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{product.name}</p>
                      <p className="tabular-nums text-sm text-muted-foreground">
                        {formatMoney(Number(product.priceMinor), currency)} · {dict.pos.subtotal.toLowerCase()}{" "}
                        <span className="font-medium text-foreground">
                          {formatMoney(Number(product.priceMinor) * quantity, currency)}
                        </span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={dict.pos.qtyDecrease}
                        onClick={() =>
                          setCart((prev) => {
                            const next = (prev[product.id] ?? 0) - 1;
                            if (next <= 0) {
                              const { [product.id]: _removed, ...rest } = prev;
                              return rest;
                            }
                            return { ...prev, [product.id]: next };
                          })
                        }
                        className="flex h-9 w-9 items-center justify-center rounded-md border border-input hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Minus className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <span className="w-6 text-center text-sm font-medium tabular-nums">{quantity}</span>
                      <button
                        type="button"
                        aria-label={dict.pos.qtyIncrease}
                        onClick={() =>
                          setCart((prev) => {
                            if (Number(product.quantity) <= (prev[product.id] ?? 0)) return prev;
                            return { ...prev, [product.id]: (prev[product.id] ?? 0) + 1 };
                          })
                        }
                        disabled={quantity >= Number(product.quantity)}
                        className="flex h-9 w-9 items-center justify-center rounded-md border border-input hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={dict.pos.removeLine}
                        onClick={() =>
                          setCart((prev) => {
                            const { [product.id]: _removed, ...rest } = prev;
                            return rest;
                          })
                        }
                        className="flex h-9 w-9 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {lines.length > 0 && (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="mb-2 text-sm font-medium text-muted-foreground">{dict.pos.paymentMethod}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setPaymentMode("now")}
                      aria-pressed={paymentMode === "now"}
                      className={cn(
                        "flex h-touch items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        paymentMode === "now" ? "border-primary bg-primary/10 text-primary" : "border-input hover:bg-accent"
                      )}
                    >
                      {dict.pos.paymentModeNow}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaymentMode("credit")}
                      aria-pressed={paymentMode === "credit"}
                      className={cn(
                        "flex h-touch items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        paymentMode === "credit" ? "border-primary bg-primary/10 text-primary" : "border-input hover:bg-accent"
                      )}
                    >
                      {dict.pos.paymentModeCredit}
                    </button>
                  </div>
                </div>

                {paymentMode === "now" ? (
                  <div className="grid grid-cols-3 gap-2">
                    {PAYMENT_METHODS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setPaymentMethod(m.id)}
                        aria-pressed={paymentMethod === m.id}
                        className={cn(
                          "flex h-touch items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                          paymentMethod === m.id ? "border-primary bg-primary/10 text-primary" : "border-input hover:bg-accent"
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div>
                    <label htmlFor="customerName" className="mb-1 block text-sm font-medium text-muted-foreground">
                      {dict.pos.customerNameLabel}
                    </label>
                    <Input
                      id="customerName"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder={dict.pos.customerNameLabel}
                    />
                  </div>
                )}

                {formError && <p className="text-sm font-medium text-destructive">{formError}</p>}
              </div>
            )}
          </div>

          {lines.length > 0 && (
            <div className="border-t border-border px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{dict.pos.total}</span>
                <span className="text-xl font-bold tabular-nums">{formatMoney(total, currency)}</span>
              </div>
              <Button size="lg" className="w-full" onClick={confirmSale}>
                {dict.pos.confirmSale}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
