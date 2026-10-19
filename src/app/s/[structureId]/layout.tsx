import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { listMyMemberships } from "@/modules/tenancy/my-memberships";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { AppShell } from "@/components/nav/app-shell";
import { ALL_NAV_ITEMS, type NavKey } from "@/components/nav/nav-items";
import { analyticsService } from "@/modules/analytics";
import { searchAction } from "@/modules/analytics/api";

export const dynamic = "force-dynamic";

// Shared chrome for every /s/[structureId]/* screen: the app shell (desktop
// sidebar / mobile drawer + bottom tab bar, grouped nav, structure
// switcher, user chip with logout). Each page below STILL re-checks the
// actor itself for its own data access (resolveActor is per-operation, not
// a one-time gate) -- this layout only needs the actor to decide which NAV
// DESTINATIONS to show, which is UX (no dead ends, no links to screens a
// role can't use), never the actual access control -- the route itself
// re-checks via resolveActor/can regardless of what the nav shows. Known
// minor duplication (one extra indexed membership lookup + one extra
// structures row per request): acceptable for now, flagged for
// frontend-next to dedupe via React's `cache()`.
export default async function StructureLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ structureId: string }>;
}) {
  const { structureId } = await params;
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  let canSell = false;
  let allowedKeys: NavKey[] = [];
  let role = "";
  try {
    const actor = await resolveActor(session, structureId);
    role = actor.role;
    canSell = can(actor, "sale:create");
    allowedKeys = ALL_NAV_ITEMS.filter(
      (item) => !item.permissions || item.permissions.some((p) => can(actor, p))
    ).map((item) => item.key);

    const { structure, notifications } = await withTenantSession(actor, async (ctx) => {
      const [row] = await ctx.db
        .select({ name: structures.name })
        .from(structures)
        .where(eq(structures.id, actor.structureId))
        .limit(1);
      // Derived, not persisted (no table/worker/cron, see docs/platform.md)
      // -- reuses the SAME sources the dashboard already computes. Best
      // effort: a glitch computing notifications must never block the
      // whole shell from rendering.
      const notifications = await analyticsService.getNotifications(ctx).catch(() => []);
      return { structure: row, notifications };
    });
    if (!structure) {
      notFound();
    }

    const memberships = await listMyMemberships(session);

    return (
      <AppShell
        structureId={structureId}
        structureName={structure.name}
        role={role}
        userId={session.user.id}
        userName={session.user.name}
        allowedKeys={allowedKeys}
        canSell={canSell}
        memberships={memberships}
        notifications={notifications}
        searchAction={searchAction.bind(null, structureId)}
      >
        {children}
      </AppShell>
    );
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      redirect("/login");
    }
    if (err instanceof NotAMemberError) {
      notFound();
    }
    throw err;
  }
}
