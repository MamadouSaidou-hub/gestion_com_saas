"use client";

import { useMemo, useState } from "react";
import { ArrowDownCircle, ArrowLeft, ArrowUpCircle, ClipboardCheck, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { StoreSelector, LockedStoreLabel } from "@/components/nav/store-selector";
import type { StockMovementDto } from "@/modules/inventory";
import type {
  OpenStockCountInput,
  StockCountDto,
  ValidateStockCountInput,
  VarianceLineDto,
} from "@/modules/stock-transfers";

export interface RealMovement extends StockMovementDto {
  productName: string;
}

export interface RealVarianceLine extends VarianceLineDto {
  productName: string;
  storeName: string;
}

export interface RealProductOption {
  id: string;
  name: string;
  sku: string;
}

export interface StoreOption {
  id: string;
  name: string;
}

type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

const REASON_LABEL_KEYS: Record<string, keyof typeof dict.stocks> = {
  sale: "reasonSale",
  purchase: "reasonPurchase",
  transfer_out: "reasonTransferOut",
  transfer_in: "reasonTransferIn",
  transfer_cancelled: "reasonTransferCancelled",
  count_adjustment: "reasonCountAdjustment",
};

function reasonLabel(reason: string): string {
  if (reason.startsWith("adjustment:")) {
    return `${dict.stocks.reasonAdjustment} -- ${reason.slice("adjustment:".length)}`;
  }
  const key = REASON_LABEL_KEYS[reason];
  return key ? (dict.stocks[key] as string) : reason;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Full-screen overlay panel -- same pattern as CategoryManager (no Radix
// dialog primitive in this codebase yet).
function Overlay({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-xl bg-card p-4 shadow-lg sm:rounded-xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={dict.common.cancel}
            className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CountWizard({
  open,
  onClose,
  warehouseId,
  products,
  openStockCountAction,
  validateStockCountAction,
  onValidated,
}: {
  open: boolean;
  onClose: () => void;
  warehouseId: string | null;
  products: RealProductOption[];
  openStockCountAction: (input: OpenStockCountInput) => Promise<ActionResult<StockCountDto>>;
  validateStockCountAction: (input: ValidateStockCountInput) => Promise<ActionResult<StockCountDto>>;
  onValidated: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<StockCountDto | null>(null);
  const [countedById, setCountedById] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setSelectedIds(new Set());
    setOpened(null);
    setCountedById({});
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleOpen() {
    if (!warehouseId || selectedIds.size === 0) return;
    setSubmitting(true);
    setError(null);
    const result = await openStockCountAction({
      idempotencyKey: `count-${warehouseId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      warehouseId,
      productIds: Array.from(selectedIds),
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpened(result.data);
  }

  async function handleValidate() {
    if (!opened) return;
    setSubmitting(true);
    setError(null);
    const lines = opened.lines
      .filter((l) => countedById[l.productId] !== undefined && countedById[l.productId] !== "")
      .map((l) => ({ productId: l.productId, countedQty: countedById[l.productId] }));
    if (lines.length === 0) {
      setSubmitting(false);
      setError(dict.stocks.countedQtyLabel);
      return;
    }
    const result = await validateStockCountAction({ stockCountId: opened.id, lines });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    reset();
    onClose();
    onValidated();
  }

  if (!opened) {
    return (
      <Overlay open={open} title={dict.stocks.openCountTitle} subtitle={dict.stocks.openCountSubtitle} onClose={handleClose}>
        {error && <p className="mb-2 text-sm font-medium text-destructive">{error}</p>}
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {products.map((product) => {
            const checked = selectedIds.has(product.id);
            return (
              <li key={product.id}>
                <label className="flex min-h-touch items-center gap-2 px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(product.id)) next.delete(product.id);
                        else next.add(product.id);
                        return next;
                      })
                    }
                  />
                  <span className="flex-1 truncate">{product.name}</span>
                  <span className="text-xs text-muted-foreground">{product.sku}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <Button className="mt-3 w-full" onClick={handleOpen} disabled={!warehouseId || selectedIds.size === 0} loading={submitting}>
          {dict.stocks.openCountSubmit}
        </Button>
      </Overlay>
    );
  }

  return (
    <Overlay open={open} title={dict.stocks.countEntryTitle} subtitle={dict.stocks.countEntrySubtitle} onClose={handleClose}>
      {error && <p className="mb-2 text-sm font-medium text-destructive">{error}</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {opened.lines.map((line) => {
          const product = products.find((p) => p.id === line.productId);
          return (
            <li key={line.productId} className="p-3">
              <p className="text-sm font-medium">{product?.name ?? line.productId}</p>
              <p className="text-xs text-muted-foreground">
                {dict.stocks.countTheoretical}: {line.theoreticalQty}
              </p>
              <Input
                className="mt-1"
                type="number"
                min={0}
                step="0.0001"
                inputMode="decimal"
                aria-label={dict.stocks.countedQtyLabel}
                placeholder={dict.stocks.countedQtyLabel}
                value={countedById[line.productId] ?? ""}
                onChange={(e) => setCountedById((prev) => ({ ...prev, [line.productId]: e.target.value }))}
              />
            </li>
          );
        })}
      </ul>
      <Button className="mt-3 w-full" onClick={handleValidate} loading={submitting}>
        {dict.stocks.validateCountSubmit}
      </Button>
    </Overlay>
  );
}

export function StockMovementsClient({
  structureId,
  structureName,
  storeOptions,
  gerantStoreName,
  currentWarehouseId,
  products,
  movements,
  inTransitByProduct,
  varianceLines,
  canAdjustStock,
  canOpenCount,
  canValidateCount,
  openStockCountAction,
  validateStockCountAction,
}: {
  structureId: string;
  structureName: string;
  storeOptions: StoreOption[];
  gerantStoreName: string | null;
  currentWarehouseId: string | null;
  products: RealProductOption[];
  movements: RealMovement[];
  inTransitByProduct: Record<string, string>;
  varianceLines: RealVarianceLine[];
  canAdjustStock: boolean;
  canOpenCount: boolean;
  canValidateCount: boolean;
  openStockCountAction: (input: OpenStockCountInput) => Promise<ActionResult<StockCountDto>>;
  validateStockCountAction: (input: ValidateStockCountInput) => Promise<ActionResult<StockCountDto>>;
}) {
  void canAdjustStock; // surfaced via the "reasonAdjustment" ledger label only, no dedicated write form in this phase
  const [query, setQuery] = useState("");
  const [countOpen, setCountOpen] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return movements;
    return movements.filter((m) => m.productName.toLowerCase().includes(q));
  }, [movements, query]);

  const inTransitEntries = Object.entries(inTransitByProduct).filter(([, qty]) => Number(qty) > 0);
  const canCount = canOpenCount && canValidateCount;

  function refresh() {
    window.location.reload();
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
            <h1 className="truncate text-base font-semibold">{dict.stocks.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
          {canCount && (
            <button
              type="button"
              onClick={() => setCountOpen(true)}
              className="flex h-touch shrink-0 items-center gap-1.5 rounded-md border border-primary px-3 text-sm font-medium text-primary hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{dict.stocks.openCountCta}</span>
            </button>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {gerantStoreName ? (
            <LockedStoreLabel name={gerantStoreName} />
          ) : storeOptions.length > 1 ? (
            <StoreSelector options={storeOptions} selectedId={currentWarehouseId} />
          ) : null}
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
        <p className="mb-2 text-sm text-muted-foreground">{dict.stocks.subtitle}</p>

        {inTransitEntries.length > 0 && (
          <div className="mb-4 rounded-lg border border-border bg-card p-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {dict.stocks.inTransitColumn}
            </p>
            <p className="mb-2 text-xs text-muted-foreground">{dict.stocks.inTransitHint}</p>
            <ul className="space-y-1">
              {inTransitEntries.map(([productId, qty]) => {
                const product = products.find((p) => p.id === productId);
                return (
                  <li key={productId} className="flex items-center justify-between text-sm">
                    <span className="truncate">{product?.name ?? productId}</span>
                    <Badge variant="secondary" className="tabular-nums">
                      {qty}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.stocks.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {results.map((movement) => {
              const isIn = movement.direction === "in";
              return (
                <li key={movement.id} className="flex items-center gap-3 p-4">
                  {isIn ? (
                    <ArrowDownCircle className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <ArrowUpCircle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{movement.productName}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {reasonLabel(movement.reason)}
                      <span className="mx-1" aria-hidden="true">
                        &middot;
                      </span>
                      {formatDateTime(movement.occurredAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge variant={isIn ? "success" : "secondary"} className="tabular-nums">
                      {isIn ? "+" : "-"}
                      {movement.quantity}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-6">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {dict.stocks.varianceTableTitle}
          </p>
          {varianceLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{dict.stocks.varianceEmpty}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="p-2">{dict.stocks.varianceColumnProduct}</th>
                    <th className="p-2">{dict.stocks.varianceColumnStore}</th>
                    <th className="p-2 text-right">{dict.stocks.varianceColumnTheoretical}</th>
                    <th className="p-2 text-right">{dict.stocks.varianceColumnCounted}</th>
                    <th className="p-2 text-right">{dict.stocks.varianceColumnVariance}</th>
                    <th className="p-2 text-right">{dict.stocks.varianceColumnValue}</th>
                  </tr>
                </thead>
                <tbody>
                  {varianceLines.map((line, idx) => {
                    const variance = Number(line.varianceQty);
                    return (
                      <tr key={`${line.stockCountId}-${line.productId}-${idx}`} className="border-b border-border last:border-0">
                        <td className="p-2">{line.productName}</td>
                        <td className="p-2">{line.storeName}</td>
                        <td className="p-2 text-right tabular-nums">{line.theoreticalQty}</td>
                        <td className="p-2 text-right tabular-nums">{line.countedQty}</td>
                        <td
                          className="p-2 text-right font-medium tabular-nums"
                          style={{ color: variance > 0 ? "var(--success)" : "var(--destructive)" }}
                        >
                          {variance > 0 ? `+${line.varianceQty}` : line.varianceQty}
                        </td>
                        <td className="p-2 text-right tabular-nums">{line.varianceValueMinor}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <a
          href={`/s/${structureId}/produits`}
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          {dict.stocks.seeCatalog}
        </a>
      </main>

      <CountWizard
        open={countOpen}
        onClose={() => setCountOpen(false)}
        warehouseId={currentWarehouseId}
        products={products}
        openStockCountAction={openStockCountAction}
        validateStockCountAction={validateStockCountAction}
        onValidated={refresh}
      />
    </div>
  );
}
