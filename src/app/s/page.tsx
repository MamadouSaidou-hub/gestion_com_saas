import { redirect } from "next/navigation";
import { ChevronRight, Store } from "lucide-react";
import { getSession } from "@/modules/identity/get-session";
import { redirectIfMustChangePassword } from "@/modules/identity/must-change-password";
import { listMyMemberships } from "@/modules/tenancy/my-memberships";
import { dict } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createStructureAction } from "./actions";

// Gated (not indexable, not public per performance.md): lists the
// structures the AUTHENTICATED session's own user is an active member of,
// via my_memberships() (migration 0002), and lets them pick one. This is
// deliberately the only page that doesn't already require a structureId --
// everything it links to does.
export const dynamic = "force-dynamic"; // always re-check the session, never cache

export default async function StructurePickerPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  redirectIfMustChangePassword(session, "/s");

  const memberships = await listMyMemberships(session);

  if (memberships.length === 0) {
    return (
      <div className="min-h-screen bg-background px-4 py-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Store className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="font-medium">{dict.structurePicker.empty}</p>
            <p className="mt-1 text-sm text-muted-foreground">{dict.structurePicker.emptyHint}</p>
          </div>

          {/* "créer ma boutique" -- a logged-in user with no structure
              hits a dead end otherwise. Minimal form: only what D8/D4
              need (name, country -> currency, VAT rate default 0). No
              warehouse/unit picker anywhere -- both created implicitly by
              createStructureAction (v1 single-warehouse decision). */}
          <form action={createStructureAction} className="space-y-4 rounded-lg border border-border bg-card p-5 shadow-sm">
            <h2 className="text-base font-semibold">{dict.createStructure.title}</h2>
            <p className="text-sm text-muted-foreground">{dict.createStructure.subtitle}</p>

            <div>
              <Label htmlFor="name">{dict.createStructure.nameLabel}</Label>
              <Input
                id="name"
                name="name"
                type="text"
                required
                maxLength={200}
                placeholder={dict.createStructure.namePlaceholder}
              />
            </div>

            <div>
              <Label htmlFor="countryCode">{dict.createStructure.countryLabel}</Label>
              <select
                id="countryCode"
                name="countryCode"
                defaultValue="SN"
                className="h-touch w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-ring"
              >
                <option value="SN">{dict.createStructure.countrySenegal}</option>
                <option value="GN">{dict.createStructure.countryGuinea}</option>
              </select>
            </div>

            <div>
              <Label htmlFor="vatRate">{dict.createStructure.vatLabel}</Label>
              <Input
                id="vatRate"
                name="vatRate"
                type="number"
                min={0}
                max={100}
                step="0.01"
                defaultValue={0}
                inputMode="decimal"
                placeholder={dict.createStructure.vatRatePlaceholder}
              />
              <p className="mt-1 text-xs text-muted-foreground">{dict.createStructure.vatHint}</p>
            </div>

            <Button type="submit" className="w-full">
              {dict.createStructure.submit}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  // UX convenience only: if there's exactly one structure, skip the picker.
  if (memberships.length === 1) {
    redirect(`/s/${memberships[0].structureId}/dashboard`);
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-md">
        <h1 className="text-xl font-semibold">{dict.structurePicker.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{dict.structurePicker.subtitle}</p>

        <ul className="mt-6 space-y-3">
          {memberships.map((m) => (
            <li key={m.structureId}>
              <a
                href={`/s/${m.structureId}/dashboard`}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {initials(m.structureName)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.structureName}</p>
                  <p className="text-sm capitalize text-muted-foreground">{m.role}</p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Two-letter monogram for the structure avatar -- cheap visual anchor to
// scan a list fast, no image upload/storage dependency needed for this.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
