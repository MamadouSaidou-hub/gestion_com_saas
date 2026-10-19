"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  LogOut,
  Menu,
  Receipt,
  Store,
  X,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "@/modules/identity/auth-client";
import { purgeScope, scopeKeyFor } from "@/lib/offline-sales-queue";
import { dict } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { NotificationItem, SearchResultDto } from "@/modules/analytics";
import { PILOTAGE_NAV, GESTION_NAV, type NavItemDef, type NavKey, navItemByKey } from "./nav-items";
import { GlobalSearch } from "./global-search";
import { NotificationsMenu } from "./notifications-menu";

export interface ShellMembership {
  structureId: string;
  structureName: string;
  role: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: dict.team.roleOwner,
  manager: dict.team.roleManager,
  cashier: dict.team.roleCashier,
  stock_keeper: dict.team.roleStockKeeper,
  accountant: dict.team.roleAccountant,
  auditor: dict.team.roleAuditor,
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// AppShell -- persistent chrome for every authenticated /s/[structureId]/*
// screen. Organisation borrowed from the BGM reference (grouped captioned
// nav, workspace/structure switcher at the top of the sidebar, a pinned
// user chip with logout at the bottom) but adapted twice, deliberately:
//
// 1. Desktop gets a permanent sidebar (BGM's layout, unchanged). Mobile
//    does NOT get the same sidebar collapsed into a hamburger-only drawer --
//    this app already made a mobile-first call (bottom tab bar) for the
//    3-4 highest-frequency destinations, which stays. The drawer (opened
//    from the topbar's hamburger) is the ESCAPE HATCH to the full grouped
//    menu (including "coming soon" screens and the structure switcher),
//    not a replacement for the thumb-reachable bottom bar. Both coexist.
// 2. No client-side fetch-on-mount for shell data: everything the shell
//    needs (structure name, role, memberships, which nav keys are visible)
//    is computed server-side in the structure layout and passed down as
//    plain props, so the shell never paints an empty state then jolts --
//    it paints once, with real data, same as the rest of this app's SSR.
// ---------------------------------------------------------------------------
export function AppShell({
  structureId,
  structureName,
  role,
  userId,
  userName,
  allowedKeys,
  canSell,
  memberships,
  notifications,
  searchAction,
  children,
}: {
  structureId: string;
  structureName: string;
  role: string;
  userId: string;
  userName: string;
  allowedKeys: NavKey[];
  canSell: boolean;
  memberships: ShellMembership[];
  notifications: NotificationItem[];
  searchAction: (query: string) => Promise<SearchResultDto>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // Close the drawer automatically on navigation (route change), so a tap
  // on a nav link doesn't leave the overlay open behind the new screen.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const allowed = new Set(allowedKeys);
  const pilotageItems = PILOTAGE_NAV.filter((item) => allowed.has(item.key));
  const gestionItems = GESTION_NAV.filter((item) => allowed.has(item.key));

  // POS screen owns the bottom of the viewport itself (running total + the
  // "Encaisser" CTA) -- the bottom tab bar is hidden there, same rule as
  // before this round's refactor (see former bottom-nav.tsx).
  const posActive = pathname === `/s/${structureId}/ventes/nouvelle`;

  async function handleLogout() {
    setLoggingOut(true);
    try {
      // Wipe this user's queued offline sales for THIS till before the
      // session goes away (db/README.md debt item 2w) -- a shared/kiosk
      // device must never carry cashier A's pending cart into cashier B's
      // session.
      await purgeScope(scopeKeyFor(structureId, userId));
    } catch {
      // Best-effort: IndexedDB may be unavailable (private mode, old
      // browser) -- never block logout on it.
    }
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* --- Desktop sidebar (md and up): permanent, grouped, captioned --- */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
        <SidebarContent
          structureId={structureId}
          structureName={structureName}
          role={role}
          userName={userName}
          memberships={memberships}
          notifications={notifications}
          searchAction={searchAction}
          pilotageItems={pilotageItems}
          gestionItems={gestionItems}
          pathname={pathname}
          switcherOpen={switcherOpen}
          setSwitcherOpen={setSwitcherOpen}
          onLogout={handleLogout}
          loggingOut={loggingOut}
        />
      </aside>

      {/* --- Mobile topbar (below md): brand + search + notifications + hamburger --- */}
      <header className="flex h-14 items-center justify-between gap-2 border-b border-border bg-card px-4 md:hidden">
        <span className="shrink-0 truncate font-semibold">{structureName}</span>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <div className="hidden min-w-0 flex-1 sm:block">
            <GlobalSearch structureId={structureId} searchAction={searchAction} />
          </div>
          <NotificationsMenu structureId={structureId} items={notifications} />
          <button
            type="button"
            aria-label={dict.nav.openMenu}
            onClick={() => setDrawerOpen(true)}
            className="flex h-touch w-touch items-center justify-center rounded-md hover:bg-accent"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* --- Mobile drawer: full grouped menu + structure switcher + logout --- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label={dict.nav.closeMenu}
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-card shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <span className="font-semibold">{structureName}</span>
              <button
                type="button"
                aria-label={dict.nav.closeMenu}
                onClick={() => setDrawerOpen(false)}
                className="flex h-touch w-touch items-center justify-center rounded-md hover:bg-accent"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <SidebarContent
              structureId={structureId}
              structureName={structureName}
              role={role}
              userName={userName}
              memberships={memberships}
              notifications={notifications}
              searchAction={searchAction}
              pilotageItems={pilotageItems}
              gestionItems={gestionItems}
              pathname={pathname}
              switcherOpen={switcherOpen}
              setSwitcherOpen={setSwitcherOpen}
              onLogout={handleLogout}
              loggingOut={loggingOut}
              hideBrandRow
            />
          </div>
        </div>
      )}

      {/* --- Main content --- */}
      <div className="flex min-h-screen flex-1 flex-col pb-20 md:pb-0">
        <div className="flex-1">{children}</div>
      </div>

      {/* --- Mobile bottom tab bar: the 3-4 highest-frequency destinations,
          always thumb-reachable, PLUS a "Plus" tab that opens the same
          drawer as the topbar hamburger for everything else. --- */}
      {!posActive && (
        <nav
          aria-label="Navigation principale"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <ul className="mx-auto flex max-w-2xl">
            <BottomTabLink
              href={`/s/${structureId}/dashboard`}
              label={dict.nav.dashboard}
              icon={navItemByKey("dashboard").icon}
              active={pathname === `/s/${structureId}/dashboard`}
            />
            {canSell && (
              <BottomTabLink
                href={`/s/${structureId}/ventes/nouvelle`}
                label={dict.nav.sale}
                icon={Receipt}
                active={pathname === `/s/${structureId}/ventes/nouvelle`}
              />
            )}
            <BottomTabLink
              href={`/s/${structureId}/produits`}
              label={dict.nav.products}
              icon={navItemByKey("products").icon}
              active={
                pathname === `/s/${structureId}/produits` ||
                pathname?.startsWith(`/s/${structureId}/produits/`)
              }
            />
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="flex h-touch-lg w-full flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
                {dict.nav.moreMenu}
              </button>
            </li>
          </ul>
        </nav>
      )}
    </div>
  );
}

function BottomTabLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <li className="flex-1">
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-touch-lg flex-col items-center justify-center gap-0.5 text-xs font-medium",
          active ? "text-primary" : "text-muted-foreground"
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={active ? 2.5 : 2} />
        {label}
      </Link>
    </li>
  );
}

function SidebarContent({
  structureId,
  structureName,
  role,
  userName,
  memberships,
  notifications,
  searchAction,
  pilotageItems,
  gestionItems,
  pathname,
  switcherOpen,
  setSwitcherOpen,
  onLogout,
  loggingOut,
  hideBrandRow,
}: {
  structureId: string;
  structureName: string;
  role: string;
  userName: string;
  memberships: ShellMembership[];
  notifications: NotificationItem[];
  searchAction: (query: string) => Promise<SearchResultDto>;
  pilotageItems: NavItemDef[];
  gestionItems: NavItemDef[];
  pathname: string | null;
  switcherOpen: boolean;
  setSwitcherOpen: (value: boolean) => void;
  onLogout: () => void;
  loggingOut: boolean;
  hideBrandRow?: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      {!hideBrandRow && (
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            GC
          </div>
          <span className="truncate font-semibold">Gestion commerciale</span>
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <GlobalSearch structureId={structureId} searchAction={searchAction} />
        </div>
        <NotificationsMenu structureId={structureId} items={notifications} />
      </div>

      {/* Structure switcher -- multi-tenant: the active structure is shown
          AND switchable here, replacing the need to go back to /s for
          anyone who belongs to more than one structure. */}
      <div className="relative border-b border-border p-3">
        <button
          type="button"
          onClick={() => setSwitcherOpen(!switcherOpen)}
          aria-label={dict.nav.switchStructure}
          aria-expanded={switcherOpen}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-accent"
        >
          <Store className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{structureName}</span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 transition-transform", switcherOpen && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        {switcherOpen && (
          <div className="absolute inset-x-3 top-full z-10 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
            <Link
              href="/s"
              className="block px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
              onClick={() => setSwitcherOpen(false)}
            >
              {dict.nav.myStructures}
            </Link>
            {memberships
              .filter((m) => m.structureId !== structureId)
              .map((m) => (
                <Link
                  key={m.structureId}
                  href={`/s/${m.structureId}/dashboard`}
                  className="block truncate px-3 py-2 text-sm hover:bg-accent"
                  onClick={() => setSwitcherOpen(false)}
                >
                  {m.structureName}
                </Link>
              ))}
          </div>
        )}
      </div>

      <nav aria-label="Navigation principale" className="flex-1 overflow-y-auto px-2 py-3">
        {pilotageItems.length > 0 && (
          <>
            <p className="px-2 pb-1 pt-2 text-xs font-semibold tracking-wide text-muted-foreground">
              {dict.nav.captionPilotage}
            </p>
            {pilotageItems.map((item) => (
              <SideNavLink key={item.key} item={item} structureId={structureId} pathname={pathname} />
            ))}
          </>
        )}
        {gestionItems.length > 0 && (
          <>
            <p className="px-2 pb-1 pt-4 text-xs font-semibold tracking-wide text-muted-foreground">
              {dict.nav.captionGestion}
            </p>
            {gestionItems.map((item) => (
              <SideNavLink key={item.key} item={item} structureId={structureId} pathname={pathname} />
            ))}
          </>
        )}
      </nav>

      {/* User chip, pinned at the bottom -- name, role, logout. */}
      <div className="border-t border-border p-3">
        <div className="mb-2 flex items-center gap-2 px-1">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initialsOf(userName)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{userName}</p>
            <p className="truncate text-xs capitalize text-muted-foreground">{roleLabel(role)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          disabled={loggingOut}
          className="flex h-touch w-full items-center gap-2 rounded-md px-3 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          {loggingOut ? dict.nav.loggingOut : dict.nav.logout}
        </button>
      </div>
    </div>
  );
}

function SideNavLink({
  item,
  structureId,
  pathname,
}: {
  item: NavItemDef;
  structureId: string;
  pathname: string | null;
}) {
  const href = item.href(structureId);
  const active = pathname === href || pathname?.startsWith(`${href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "mb-0.5 flex min-h-touch items-center gap-2.5 rounded-md px-2.5 text-sm font-medium",
        active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.comingSoon && (
        <span className="shrink-0 rounded-full border border-dashed border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
          {dict.nav.comingSoonBadge}
        </span>
      )}
    </Link>
  );
}
