import { Info } from "lucide-react";
import { dict } from "@/lib/i18n";

// Visible "données de démonstration" banner -- required on every screen
// still backed by sample data (fournisseurs/factures/stocks/équipe this
// round) so nobody mistakes a mock figure for a real one. Deliberately
// NOT using the `warning` badge variant (reserved for stock/attention
// signals per badge.tsx's own convention) -- neutral/secondary styling,
// same dashed-border language already used for "Bientôt" placeholders.
export function MockDataBanner() {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{dict.common.mockDataBanner}</span>
    </div>
  );
}
