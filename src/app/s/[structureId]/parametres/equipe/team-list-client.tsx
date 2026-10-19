"use client";

import { useMemo, useState, useTransition } from "react";
import {
  ArrowLeft,
  Calculator,
  Crown,
  Eye,
  Package,
  Plus,
  Receipt,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { dict } from "@/lib/i18n";
import type { MembershipRole } from "@/modules/tenancy/types";
import type { MemberListItem } from "@/modules/tenancy/list-members";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import {
  createMemberAction,
  changeMemberRoleAction,
  setMemberSuspendedAction,
  assignMemberWarehouseAction,
} from "./actions";

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

const ALL_ROLES: MembershipRole[] = ["owner", "manager", "cashier", "stock_keeper", "accountant", "auditor"];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function statusLabel(status: MemberListItem["status"]): string {
  if (status === "active") return dict.team.statusActive;
  if (status === "invited") return dict.team.statusInvited;
  return dict.team.statusSuspended;
}

interface Store {
  id: string;
  name: string;
}

export function TeamListClient({
  structureId,
  structureName,
  actorUserId,
  actorRole,
  initialMembers,
  stores,
  canCreateMember,
  canChangeRole,
  canSuspend,
  canAssignStore,
}: {
  structureId: string;
  structureName: string;
  actorUserId: string;
  actorRole: MembershipRole;
  initialMembers: MemberListItem[];
  stores: Store[];
  canCreateMember: boolean;
  canChangeRole: boolean;
  canSuspend: boolean;
  canAssignStore: boolean;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  }, [members, query]);

  function patchMember(userId: string, patch: Partial<MemberListItem>) {
    setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, ...patch } : m)));
  }

  function handleCreate(formData: FormData) {
    setError(null);
    const warehouseId = String(formData.get("warehouseId") || "") || null;
    startTransition(async () => {
      const result = await createMemberAction(structureId, {
        name: String(formData.get("name") || ""),
        email: String(formData.get("email") || ""),
        password: String(formData.get("password") || ""),
        role: String(formData.get("role") || "cashier") as MembershipRole,
        warehouseId,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setShowForm(false);
      // Re-fetch isn't wired here to keep this a single round trip -- append
      // a locally-shaped row; the next full page load will reconcile it
      // against the server (same optimistic-append pattern used elsewhere,
      // e.g. magasins-client.tsx).
      setMembers((prev) => [
        ...prev,
        {
          userId: result.data.userId,
          name: String(formData.get("name") || ""),
          email: String(formData.get("email") || ""),
          role: String(formData.get("role") || "cashier") as MembershipRole,
          status: "active",
          warehouseId,
          warehouseName: warehouseId ? stores.find((s) => s.id === warehouseId)?.name ?? null : null,
          joinedOn: new Date().toISOString(),
          mustChangePassword: true,
        },
      ]);
    });
  }

  function handleRoleChange(userId: string, newRole: MembershipRole) {
    setError(null);
    startTransition(async () => {
      const result = await changeMemberRoleAction(structureId, userId, newRole);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      patchMember(userId, { role: newRole, warehouseId: newRole === "owner" ? null : undefined });
    });
  }

  function handleSuspendToggle(userId: string, suspended: boolean) {
    setError(null);
    const confirmed = window.confirm(suspended ? dict.team.confirmSuspend : dict.team.confirmReactivate);
    if (!confirmed) return;
    startTransition(async () => {
      const result = await setMemberSuspendedAction(structureId, userId, suspended);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      patchMember(userId, { status: suspended ? "suspended" : "active" });
    });
  }

  function handleAssignStore(userId: string, warehouseId: string | null) {
    setError(null);
    startTransition(async () => {
      const result = await assignMemberWarehouseAction(structureId, userId, warehouseId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      patchMember(userId, {
        warehouseId,
        warehouseName: warehouseId ? stores.find((s) => s.id === warehouseId)?.name ?? null : null,
      });
    });
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
          {canCreateMember && (
            <Button type="button" size="sm" onClick={() => setShowForm((s) => !s)}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{dict.team.createMember}</span>
            </Button>
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

        {error && (
          <p role="alert" className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {canCreateMember && showForm && (
          <Card className="mb-4">
            <CardContent className="p-4">
              <h2 className="mb-3 text-sm font-semibold">{dict.team.createMemberTitle}</h2>
              <form action={(formData) => handleCreate(formData)} className="space-y-3">
                <div>
                  <Label htmlFor="name">{dict.team.nameLabel}</Label>
                  <Input id="name" name="name" required maxLength={200} placeholder={dict.team.namePlaceholder} />
                </div>
                <div>
                  <Label htmlFor="email">{dict.team.emailLabel}</Label>
                  <Input id="email" name="email" type="email" required maxLength={320} placeholder={dict.team.emailPlaceholder} />
                </div>
                <div>
                  <Label htmlFor="password">{dict.team.passwordLabel}</Label>
                  <Input id="password" name="password" type="password" required minLength={8} maxLength={200} />
                  <p className="mt-1 text-xs text-muted-foreground">{dict.team.passwordHint}</p>
                </div>
                <div>
                  <Label htmlFor="role">{dict.team.roleLabel}</Label>
                  <select
                    id="role"
                    name="role"
                    defaultValue="cashier"
                    className="flex h-touch w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {ALL_ROLES.filter((r) => actorRole === "owner" || r !== "owner").map((r) => (
                      <option key={r} value={r}>
                        {ROLE_PRESENTATION[r].label}
                      </option>
                    ))}
                  </select>
                </div>
                {stores.length > 0 && (
                  <div>
                    <Label htmlFor="warehouseId">{dict.team.storeLabel}</Label>
                    <select
                      id="warehouseId"
                      name="warehouseId"
                      defaultValue=""
                      className="flex h-touch w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <option value="">{dict.team.storeNone}</option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <Button type="submit" disabled={isPending} className="w-full">
                  {isPending ? dict.team.createSubmitting : dict.team.createSubmit}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

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
              const isSelf = member.userId === actorUserId;
              const targetIsOwner = member.role === "owner";
              const roleChangeAllowed = canChangeRole && !isSelf && (actorRole === "owner" || !targetIsOwner);
              const suspendAllowed = canSuspend && !isSelf;
              const storeAllowed = canAssignStore && member.role !== "owner" && stores.length > 0;

              return (
                <li key={member.userId} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{member.name}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {member.email}
                      <span className="mx-1" aria-hidden="true">
                        &middot;
                      </span>
                      {dict.team.joinedOn} {formatDate(member.joinedOn)}
                      {member.warehouseName && (
                        <>
                          <span className="mx-1" aria-hidden="true">
                            &middot;
                          </span>
                          {member.warehouseName}
                        </>
                      )}
                    </p>
                  </div>

                  <Badge variant={presentation.variant} className="shrink-0 gap-1">
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    {presentation.label}
                  </Badge>

                  <Badge variant={member.status === "suspended" ? "outline" : "secondary"} className="shrink-0">
                    {statusLabel(member.status)}
                  </Badge>

                  {member.mustChangePassword && (
                    <Badge variant="outline" className="shrink-0 text-xs text-muted-foreground">
                      {dict.team.mustChangePasswordBadge}
                    </Badge>
                  )}

                  {roleChangeAllowed && (
                    <select
                      aria-label={`${dict.team.changeRole} ${member.name}`}
                      value={member.role}
                      disabled={isPending}
                      onChange={(e) => handleRoleChange(member.userId, e.target.value as MembershipRole)}
                      className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {ALL_ROLES.filter((r) => actorRole === "owner" || r !== "owner").map((r) => (
                        <option key={r} value={r}>
                          {ROLE_PRESENTATION[r].label}
                        </option>
                      ))}
                    </select>
                  )}

                  {storeAllowed && (
                    <select
                      aria-label={`${dict.team.assignStore} ${member.name}`}
                      value={member.warehouseId ?? ""}
                      disabled={isPending}
                      onChange={(e) => handleAssignStore(member.userId, e.target.value || null)}
                      className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <option value="">{dict.team.storeNone}</option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}

                  {suspendAllowed && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleSuspendToggle(member.userId, member.status !== "suspended")}
                    >
                      {member.status === "suspended" ? dict.team.reactivate : dict.team.suspend}
                    </Button>
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
