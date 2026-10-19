"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { dict } from "@/lib/i18n";
import type { SupportedCurrency } from "@/lib/money";
import type { RebateScaleDto, RebateTierInput } from "@/modules/rebates";

type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

interface TierRow {
  thresholdQty: string;
  rebatePerUnitMinor: string;
}

function scaleToRows(scale: RebateScaleDto | null): TierRow[] {
  if (!scale || scale.tiers.length === 0) {
    return [{ thresholdQty: "", rebatePerUnitMinor: "" }];
  }
  return scale.tiers.map((t) => ({ thresholdQty: t.thresholdQty, rebatePerUnitMinor: t.rebatePerUnitMinor }));
}

// RebateScaleEditor -- shared "Barème" tier-configuration UI for both the
// customer and supplier detail screens. Always submits the WHOLE tier list
// (create for a brand-new scale, full replace for an existing one -- see
// updateRebateScaleTiers's header comment) so there is exactly one write
// path under the hood, never a second, subtly different one invented by
// this screen. The informational banner is shown by the CALLER (the
// detail page already has one next to the live progress view); this
// component only edits thresholds, it never shows a balance.
export function RebateScaleEditor({
  scale,
  currency,
  canWrite,
  party,
  createRebateScaleAction,
  updateRebateScaleTiersAction,
  onSuccess,
}: {
  scale: RebateScaleDto | null;
  currency: SupportedCurrency;
  canWrite: boolean;
  party: { customerId: string } | { supplierId: string };
  createRebateScaleAction: (input: {
    customerId?: string | null;
    supplierId?: string | null;
    currencyCode: string;
    tiers: RebateTierInput[];
  }) => Promise<ActionResult<RebateScaleDto>>;
  updateRebateScaleTiersAction: (scaleId: string, tiers: RebateTierInput[]) => Promise<ActionResult<RebateScaleDto>>;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TierRow[]>(scaleToRows(scale));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function updateRow(index: number, field: keyof TierRow, value: string) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  function addRow() {
    setRows((prev) => [...prev, { thresholdQty: "", rebatePerUnitMinor: "" }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setError(null);
    setNotice(null);
    const tiers: RebateTierInput[] = rows
      .filter((r) => r.thresholdQty.trim() !== "" && r.rebatePerUnitMinor.trim() !== "")
      .map((r) => ({ thresholdQty: r.thresholdQty.trim(), rebatePerUnitMinor: r.rebatePerUnitMinor.trim() }));
    if (tiers.length === 0) {
      setError(dict.rebates.tierMinOneRequired);
      return;
    }

    setPending(true);
    const result = scale
      ? await updateRebateScaleTiersAction(scale.id, tiers)
      : await createRebateScaleAction({ ...party, currencyCode: currency, tiers });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotice(dict.rebates.tierSavedSuccess);
    setOpen(false);
    onSuccess();
  }

  if (!canWrite) {
    return null;
  }

  if (!open) {
    return (
      <div>
        {notice && <p className="mb-2 text-sm text-success-foreground">{notice}</p>}
        <button
          type="button"
          onClick={() => {
            setRows(scaleToRows(scale));
            setOpen(true);
          }}
          className="h-touch rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
        >
          {scale ? dict.rebates.editCta : dict.rebates.configCta}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      <h3 className="mb-2 text-sm font-semibold">{dict.rebates.configTitle}</h3>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium" htmlFor={`tier-threshold-${index}`}>
                {dict.rebates.thresholdLabel}
              </label>
              <Input
                id={`tier-threshold-${index}`}
                value={row.thresholdQty}
                onChange={(e) => updateRow(index, "thresholdQty", e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium" htmlFor={`tier-rebate-${index}`}>
                {dict.rebates.rebatePerUnitLabel}
              </label>
              <Input
                id={`tier-rebate-${index}`}
                value={row.rebatePerUnitMinor}
                onChange={(e) => updateRow(index, "rebatePerUnitMinor", e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => removeRow(index)}
              disabled={rows.length <= 1}
              aria-label={dict.rebates.removeTierCta}
              className="h-touch shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
            >
              {dict.rebates.removeTierCta}
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="mt-2 h-touch rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground hover:bg-accent"
      >
        {dict.rebates.addTierCta}
      </button>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={handleSave}
          className="h-touch rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {dict.rebates.saveCta}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="h-touch rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
        >
          {dict.rebates.cancelCta}
        </button>
      </div>
    </div>
  );
}
