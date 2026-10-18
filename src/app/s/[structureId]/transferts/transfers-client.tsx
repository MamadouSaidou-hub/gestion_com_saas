"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowLeftRight, Plus, Search, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { StoreSelector, LockedStoreLabel } from "@/components/nav/store-selector";
import type { CreateTransferInput, TransferDto, CancelTransferInput } from "@/modules/stock-transfers";

type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export interface RealProductOption {
  id: string;
  name: string;
  sku: string;
}

export interface StoreOption {
  id: string;
  name: string;
}

const STATUS_LABEL: Record<TransferDto["status"], string> = {
  in_transit: dict.transfers.statusInTransit,
  received: dict.transfers.statusReceived,
  cancelled: dict.transfers.statusCancelled,
};

const STATUS_BADGE: Record<TransferDto["status"], "secondary" | "success" | "destructive"> = {
  in_transit: "secondary",
  received: "success",
  cancelled: "destructive",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

interface ItemRow {
  productId: string;
  quantity: string;
}

function NewTransferForm({
  storeOptions,
  lockedFromWarehouseId,
  products,
  createTransferAction,
  onCreated,
}: {
  storeOptions: StoreOption[];
  lockedFromWarehouseId: string | null;
  products: RealProductOption[];
  createTransferAction: (input: CreateTransferInput) => Promise<ActionResult<TransferDto>>;
  onCreated: () => void;
}) {
  const [fromWarehouseId, setFromWarehouseId] = useState(lockedFromWarehouseId ?? storeOptions[0]?.id ?? "");
  const [toWarehouseId, setToWarehouseId] = useState(
    storeOptions.find((o) => o.id !== (lockedFromWarehouseId ?? storeOptions[0]?.id))?.id ?? ""
  );
  const [items, setItems] = useState<ItemRow[]>([{ productId: "", quantity: "1" }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateItem(index: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function addItem() {
    setItems((rows) => [...rows, { productId: "", quantity: "1" }]);
  }
  function removeItem(index: number) {
    setItems((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!fromWarehouseId || !toWarehouseId) {
      setError(dict.transfers.missingStoreError);
      return;
    }
    if (fromWarehouseId === toWarehouseId) {
      setError(dict.transfers.sameStoreError);
      return;
    }
    setSubmitting(true);
    const result = await createTransferAction({
      idempotencyKey: `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      fromWarehouseId,
      toWarehouseId,
      lines: items
        .filter((item) => item.productId && Number(item.quantity) > 0)
        .map((item) => ({ productId: item.productId, quantity: item.quantity })),
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onCreated();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && <p className="text-sm font-medium text-destructive">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{dict.transfers.fromStoreLabel}</Label>
          {lockedFromWarehouseId ? (
            <p className="mt-1 text-sm font-medium">{storeOptions.find((o) => o.id === lockedFromWarehouseId)?.name}</p>
          ) : (
            <select
              value={fromWarehouseId}
              onChange={(e) => setFromWarehouseId(e.target.value)}
              className="h-touch w-full rounded-md border border-input bg-background px-3 text-base"
            >
              {storeOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <Label>{dict.transfers.toStoreLabel}</Label>
          <select
            value={toWarehouseId}
            onChange={(e) => setToWarehouseId(e.target.value)}
            className="h-touch w-full rounded-md border border-input bg-background px-3 text-base"
          >
            {storeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Label>{dict.transfers.articlesLabel}</Label>
      {items.map((item, index) => (
        <div key={index} className="flex items-end gap-2">
          <select
            value={item.productId}
            onChange={(e) => updateItem(index, { productId: e.target.value })}
            className="h-touch flex-1 rounded-md border border-input bg-background px-3 text-base"
          >
            <option value="">--</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            type="number"
            min={0.0001}
            step="0.0001"
            inputMode="decimal"
            value={item.quantity}
            onChange={(e) => updateItem(index, { quantity: e.target.value })}
            className="w-24"
          />
          <button
            type="button"
            onClick={() => removeItem(index)}
            disabled={items.length === 1}
            aria-label={dict.common.cancel}
            className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addItem} className="text-sm font-medium text-primary hover:underline">
        + {dict.transfers.addLineCta}
      </button>

      <Button type="submit" className="w-full" loading={submitting}>
        {dict.transfers.createSubmit}
      </Button>
    </form>
  );
}

export function TransfersClient({
  structureId,
  structureName,
  storeOptions,
  gerantStoreName,
  currentWarehouseId,
  products,
  transfers,
  warehouseNameById,
  canCreate,
  canReceive,
  canCancel,
  createTransferAction,
  receiveTransferAction,
  cancelTransferAction,
}: {
  structureId: string;
  structureName: string;
  storeOptions: StoreOption[];
  gerantStoreName: string | null;
  currentWarehouseId: string | null;
  products: RealProductOption[];
  transfers: TransferDto[];
  warehouseNameById: Record<string, string>;
  canCreate: boolean;
  canReceive: boolean;
  canCancel: boolean;
  createTransferAction: (input: CreateTransferInput) => Promise<ActionResult<TransferDto>>;
  receiveTransferAction: (transferId: string) => Promise<ActionResult<TransferDto>>;
  cancelTransferAction: (input: CancelTransferInput) => Promise<ActionResult<TransferDto>>;
}) {
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!actionError) return;
    const timeout = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(timeout);
  }, [actionError]);

  const filtered = transfers.filter((t) => t.reference.toLowerCase().includes(search.trim().toLowerCase()));

  function refresh() {
    setShowForm(false);
    window.location.reload();
  }

  async function handleReceive(transferId: string) {
    setBusyId(transferId);
    setActionError(null);
    const result = await receiveTransferAction(transferId);
    setBusyId(null);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    window.location.reload();
  }

  async function handleCancel(transferId: string) {
    setBusyId(transferId);
    setActionError(null);
    const result = await cancelTransferAction({ transferId, reason: null });
    setBusyId(null);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
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
            <h1 className="truncate text-base font-semibold">{dict.transfers.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="flex h-touch shrink-0 items-center gap-1.5 rounded-md border border-primary px-3 text-sm font-medium text-primary hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{dict.transfers.createCta}</span>
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

        <div className="mt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={dict.transfers.searchPlaceholder}
              className="pl-9"
              aria-label={dict.transfers.searchPlaceholder}
            />
          </div>
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.nav.captionPilotage },
            { label: dict.transfers.title },
          ]}
        />
        <p className="mb-2 text-sm text-muted-foreground">{dict.transfers.subtitle}</p>

        {actionError && <p className="mb-2 text-sm font-medium text-destructive">{actionError}</p>}

        {showForm && canCreate && (
          <div className="mb-4 rounded-lg border border-border bg-card p-4 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold">{dict.transfers.createTitle}</h2>
            <p className="mb-3 text-xs text-muted-foreground">{dict.transfers.createSubtitle}</p>
            <NewTransferForm
              storeOptions={storeOptions}
              lockedFromWarehouseId={gerantStoreName ? currentWarehouseId : null}
              products={products}
              createTransferAction={createTransferAction}
              onCreated={refresh}
            />
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.transfers.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {filtered.map((transfer) => (
              <li key={transfer.id} className="p-4">
                <div className="flex items-center gap-3">
                  <ArrowLeftRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">#{transfer.reference}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {warehouseNameById[transfer.fromWarehouseId] ?? transfer.fromWarehouseId}
                      {" -> "}
                      {warehouseNameById[transfer.toWarehouseId] ?? transfer.toWarehouseId}
                      <span className="mx-1" aria-hidden="true">
                        &middot;
                      </span>
                      {formatDateTime(transfer.createdAt)}
                    </p>
                  </div>
                  <Badge variant={STATUS_BADGE[transfer.status]}>{STATUS_LABEL[transfer.status]}</Badge>
                </div>
                {transfer.status === "in_transit" && (
                  <div className="mt-2 flex gap-3">
                    {canReceive && (
                      <button
                        type="button"
                        disabled={busyId === transfer.id}
                        onClick={() => handleReceive(transfer.id)}
                        className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
                      >
                        {dict.transfers.receiveCta}
                      </button>
                    )}
                    {canCancel && (
                      <button
                        type="button"
                        disabled={busyId === transfer.id}
                        onClick={() => handleCancel(transfer.id)}
                        className="text-sm font-medium text-destructive hover:underline disabled:opacity-50"
                      >
                        {dict.transfers.cancelCta}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
