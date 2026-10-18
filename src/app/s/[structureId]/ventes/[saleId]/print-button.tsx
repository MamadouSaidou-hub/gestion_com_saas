"use client";

import { Printer } from "lucide-react";
import { dict } from "@/lib/i18n";

// The ONLY client-side bit of the document screen: `window.print()`. No PDF
// library -- the document itself is server-rendered HTML with `@media
// print` CSS (see globals below), which is what the 3G/low-bandwidth
// budget (performance.md) actually requires: zero extra JS download for
// anything beyond this one button.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="flex h-touch items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring print:hidden"
    >
      <Printer className="h-4 w-4" aria-hidden="true" />
      {dict.saleDocument.printCta}
    </button>
  );
}
