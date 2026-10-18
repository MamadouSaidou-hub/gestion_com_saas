import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  FileText,
  LayoutDashboard,
  Package,
  Receipt,
  Store,
  Truck,
  UserCog,
} from "lucide-react";
import type { Permission } from "@/modules/tenancy/permissions";
import { dict } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Shared navigation data -- the SINGLE source of truth for the app shell's
// grouped sidebar/drawer (desktop sidebar + mobile drawer, see app-shell.tsx)
// and for the mobile bottom tab bar's "full menu" escape hatch.
//
// Deliberately plain data, no "use client": the structure layout (a Server
// Component) imports this to decide which KEYS are visible for the current
// actor (server-side permission check, never trust the client), and
// AppShell (a Client Component) imports the SAME file to resolve those keys
// back to icons/labels/hrefs for rendering. Lucide icon components aren't
// serializable across the server/client boundary, so only the filtered list
// of `NavKey` strings crosses that boundary (see structure layout.tsx) --
// never a React element or a function reference.
// ---------------------------------------------------------------------------

export type NavKey =
  | "dashboard"
  | "sales"
  | "stockMovements"
  | "products"
  | "suppliers"
  | "invoices"
  | "team"
  | "warehouses";

export interface NavItemDef {
  key: NavKey;
  href: (structureId: string) => string;
  label: string;
  icon: LucideIcon;
  /**
   * Visible to any active member if omitted. Otherwise visible when the
   * actor holds ANY of these permissions (OR, not AND) -- e.g. "Équipe" is
   * visible to settings:write (owner/manager) OR audit:read (auditor).
   */
  permissions?: Permission[];
  /**
   * Screen still runs on sample/demo data (shows MockDataBanner) -- stays
   * reachable and labelled "Bientôt" rather than hidden, per the
   * no-dead-ends rule. Never used to hide a destination.
   */
  comingSoon?: boolean;
}

export const PILOTAGE_NAV: NavItemDef[] = [
  {
    key: "dashboard",
    href: (id) => `/s/${id}/dashboard`,
    label: dict.nav.dashboard,
    icon: LayoutDashboard,
  },
  {
    key: "sales",
    href: (id) => `/s/${id}/ventes/nouvelle`,
    label: dict.nav.sales,
    icon: Receipt,
    permissions: ["sale:create"],
  },
  {
    key: "stockMovements",
    href: (id) => `/s/${id}/stocks`,
    label: dict.nav.stockMovements,
    icon: ClipboardList,
    comingSoon: true,
  },
];

export const GESTION_NAV: NavItemDef[] = [
  {
    key: "products",
    href: (id) => `/s/${id}/produits`,
    label: dict.products.title,
    icon: Package,
  },
  {
    key: "suppliers",
    href: (id) => `/s/${id}/fournisseurs`,
    label: dict.nav.suppliers,
    icon: Truck,
    comingSoon: true,
  },
  {
    key: "invoices",
    href: (id) => `/s/${id}/factures`,
    label: dict.nav.invoices,
    icon: FileText,
    comingSoon: true,
  },
  {
    key: "team",
    href: (id) => `/s/${id}/parametres/equipe`,
    label: dict.nav.team,
    icon: UserCog,
    permissions: ["settings:write", "audit:read"],
    comingSoon: true,
  },
  {
    // Multi-store (migration 0014): "Magasins" -- list/create/archive is
    // owner-gated INSIDE the screen itself; the nav entry is shown to
    // every role that holds `warehouse:write` (owner/manager/stock_keeper
    // in the shared matrix) so a manager/stock_keeper can still see the
    // READ-ONLY store list (needed to understand a gerant's scope), even
    // though create/archive there is further restricted to `role ===
    // "owner"` by create-warehouse.ts/archive-warehouse.ts.
    key: "warehouses",
    href: (id) => `/s/${id}/parametres/magasins`,
    label: dict.warehouses.title,
    icon: Store,
    permissions: ["warehouse:write"],
  },
];

export const ALL_NAV_ITEMS: NavItemDef[] = [...PILOTAGE_NAV, ...GESTION_NAV];

export function navItemByKey(key: NavKey): NavItemDef {
  const item = ALL_NAV_ITEMS.find((i) => i.key === key);
  if (!item) {
    throw new Error(`Unknown nav key: ${key}`);
  }
  return item;
}
