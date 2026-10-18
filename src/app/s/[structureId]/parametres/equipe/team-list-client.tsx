"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Calculator,
  Crown,
  Eye,
  Package,
  Phone,
  Plus,
  Receipt,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { dict } from "@/lib/i18n";
import type { MembershipRole } from "@/modules/tenancy/types";
import { MockDataBanner } from "@/components/mock-data-banner";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { MOCK_TEAM } from "./mock-team";

// Role presentation table -- one authoritative place mapping the real
// `MembershipRole` union (permissions.ts) to a label/icon/badge weight.
// Deliberately does NOT use `warning`/`destructive` badge variants to color-
// code roles: those are reserved for stock alerts and destructive actions
// respectively (design direction). Distinctness instead comes from a unique
// icon per role plus a weight tier (decision-making roles get the primary-
// tinted `default` variant, operational roles `secondary`, the review-only
// auditor role `outline`).
const ROLE_PRESENTATION: Record<
  MembershipRole,
  { label: string; icon: typeof Crown; variant: BadgeProps["variant"] }
> = {
  owner: { label: dict.team.roleOwner, icon: Crown, variant: "default" },
  manager: { label: dict.team.roleManager, icon: ShieldCheck, variant: "default" },
  cashier: { label: dict.team.roleCashier, icon: Receipt, variant: "secondary" },
  stock_keeper: { label: dict.team.roleStockKeeper, icon: Package, variant: "secondary" },
  accountant: { label: dict.team.roleAccountant, icon: Calculator, variant: "secondary" },
  auditor: { label: dict.team.roleAuditor, icon: Eye, variant: "outline" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function TeamListClient({
  structureId,
  structureName,
  canInvite,
}: {
  structureId: string;
  structureName: string;
  canInvite: boolean;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MOCK_TEAM;
    return MOCK_TEAM.filter((m) => m.name.toLowerCase().includes(q));
  }, [query]);

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
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{dict.team.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
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
              placeholder={dict.team.searchPlaceholder}
              className="pl-9"
              aria-label={dict.team.searchPlaceholder}
            />
          </div>
          {canInvite && (
            <button
              type="button"
              disabled
              title="Bientôt disponible"
              className="flex h-touch shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-3 text-sm font-medium text-muted-foreground"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{dict.team.inviteMember}</span>
            </button>
          )}
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.nav.captionGestion },
            { label: dict.team.title },
          ]}
        />
        <MockDataBanner />
        <p className="mb-2 text-sm text-muted-foreground">
          {results.length} {dict.team.title.toLowerCase()}
        </p>

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.team.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {results.map((member) => {
              const presentation = ROLE_PRESENTATION[member.role];
              const Icon = presentation.icon;
              return (
                <li key={member.id} className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{member.name}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      <a
                        href={`tel:${member.phone}`}
                        className="inline-flex items-center gap-1 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                        {member.phone}
                      </a>
                      <span className="mx-1" aria-hidden="true">
                        &middot;
                      </span>
                      {dict.team.joinedOn} {formatDate(member.joinedOn)}
                    </p>
                  </div>
                  <Badge variant={presentation.variant} className="shrink-0 gap-1">
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    {presentation.label}
                  </Badge>
                  {/* Multi-store (migration 0014): a "gerant" is a manager
                      pinned to one store (memberships.warehouse_id). The
                      real assignment action (assignMemberWarehouseAction)
                      is fully wired server-side -- disabled here for the
                      same reason "Inviter" above is: this screen still
                      renders sample data, not the real membership roster,
                      see mock-team.ts. */}
                  {member.role === "manager" && (
                    <button
                      type="button"
                      disabled
                      title="Bientôt disponible"
                      className="shrink-0 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground"
                    >
                      {dict.team.assignStore}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
