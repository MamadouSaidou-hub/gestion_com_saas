"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { dict } from "@/lib/i18n";
import { issueInvoiceForSaleAction } from "@/modules/billing/api";

// "émettre une facture" -- calls `billingService.issueInvoiceForSale`
// (via the thin Server Action) and refreshes the page so it re-renders as
// an invoice instead of a ticket. No client-side invoice number
// computation -- the server is the sole source of the doc number.
export function IssueInvoiceButton({ structureId, saleId }: { structureId: string; saleId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    const result = await issueInvoiceForSaleAction(structureId, saleId);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="print:hidden">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="flex h-touch items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <FileText className="h-4 w-4" aria-hidden="true" />
        {dict.saleDocument.issueInvoiceCta}
      </button>
      {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
    </div>
  );
}
