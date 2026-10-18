"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Store } from "lucide-react";
import { dict } from "@/lib/i18n";

export interface StoreSelectorOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// StoreSelector -- multi-store (migration 0014), rule D/"single-store shop
// must not get more complex": the CALLER decides whether to render this at
// all. It must NEVER be rendered for:
//  - a store-scoped actor ("gerant") -- they have exactly ONE store, so a
//    selector with one disabled option is worse than just naming it (see
//    LockedStoreLabel below instead).
//  - a tenant with a single store -- the UI stays exactly as simple as
//    today; the selector only appears from the SECOND store onward.
//
// Implemented as a plain `<form method="get">` so the baseline (no JS yet,
// throttled 3G) still WORKS -- picking a store and hitting the (visually
// hidden but real) submit button navigates via a normal GET, no different
// from any other filter link. The onChange auto-submit is a progressive
// enhancement once hydrated, not a requirement for the control to function.
// ---------------------------------------------------------------------------
export function StoreSelector({ options, selectedId }: { options: StoreSelectorOption[]; selectedId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("warehouseId", value);
    } else {
      params.delete("warehouseId");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <form method="get" className="flex items-center gap-2">
      <Store className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <label htmlFor="warehouseId" className="sr-only">
        {dict.storeSelector.label}
      </label>
      <select
        id="warehouseId"
        name="warehouseId"
        defaultValue={selectedId ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
      >
        <option value="">{dict.storeSelector.allStores}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="h-9 rounded-md border border-input px-2 text-sm">
          {dict.common.save}
        </button>
      </noscript>
    </form>
  );
}

// Rendered instead of StoreSelector for a store-scoped actor ("gerant") --
// a locked, read-only label naming their one store, not a disabled
// dropdown (per the product decision this is based on: "showing a selector
// with one disabled option is worse than showing the store's name").
export function LockedStoreLabel({ name }: { name: string }) {
  return (
    <span
      className="flex items-center gap-2 text-sm text-muted-foreground"
      title={dict.storeSelector.lockedHint}
    >
      <Store className="h-4 w-4 shrink-0" aria-hidden="true" />
      {name}
    </span>
  );
}
