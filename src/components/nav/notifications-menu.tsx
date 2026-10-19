"use client";

import { useState } from "react";
import { Bell } from "lucide-react";
import { dict } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { NotificationItem, NotificationKind } from "@/modules/analytics";

const LABEL_BY_KIND: Record<NotificationKind, string> = {
  low_stock: dict.notifications.lowStock,
  receivable_overdue: dict.notifications.receivableOverdue,
  receivable_due_soon: dict.notifications.receivableDueSoon,
  transfer_awaiting_receipt: dict.notifications.transferAwaitingReceipt,
  rebate_tier_reached: dict.notifications.rebateTierReached,
};

function hrefFor(structureId: string, item: NotificationItem): string {
  switch (item.kind) {
    case "low_stock":
      return `/s/${structureId}/produits`;
    case "receivable_overdue":
    case "receivable_due_soon":
      return item.customerId ? `/s/${structureId}/clients/${item.customerId}` : `/s/${structureId}/clients`;
    case "transfer_awaiting_receipt":
      return `/s/${structureId}/transferts`;
    case "rebate_tier_reached":
      return item.customerId
        ? `/s/${structureId}/clients/${item.customerId}`
        : item.supplierId
          ? `/s/${structureId}/fournisseurs/${item.supplierId}`
          : `/s/${structureId}/dashboard`;
  }
}

// ---------------------------------------------------------------------------
// NotificationsMenu -- derived, never persisted (no table/worker/cron, see
// docs/platform.md). Data is computed server-side in the structure layout
// (role- and store-aware, same `can()`/`resolveStoreScope` discipline as
// everything else) and passed down as a plain prop -- this component only
// renders it, no client-side fetch-on-mount.
// ---------------------------------------------------------------------------
export function NotificationsMenu({ structureId, items }: { structureId: string; items: NotificationItem[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={dict.notifications.title}
        aria-expanded={open}
        className="relative flex h-touch w-touch items-center justify-center rounded-md hover:bg-accent"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {items.length > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {items.length > 9 ? "9+" : items.length}
          </span>
        )}
      </button>
      {open && (
        <>
          <button type="button" aria-label="Fermer" className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
            {items.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">{dict.notifications.empty}</p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((item) => (
                  <li key={item.id}>
                    <a
                      href={hrefFor(structureId, item)}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "block px-3 py-2.5 text-sm hover:bg-accent",
                        (item.kind === "receivable_overdue" || item.kind === "low_stock") && "text-destructive"
                      )}
                    >
                      {LABEL_BY_KIND[item.kind]}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
