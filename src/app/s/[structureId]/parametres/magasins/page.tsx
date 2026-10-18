import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { dict } from "@/lib/i18n";
import { catalogService } from "@/modules/catalog";
import { MagasinsClient } from "./magasins-client";

// ---------------------------------------------------------------------------
// Gated, structure-scoped page: /s/[structureId]/parametres/magasins
// (multi-store, migration 0014) -- REAL data end to end (unlike most other
// screens in this app today, which still render DESIGN MOCKUP data -- see
// their own headers). List is visible to any actor with `warehouse:write`
// (owner/manager/stock_keeper, per the shared permission matrix); create/
// archive stays owner-only, enforced a SECOND time inside
// createWarehouse/archiveWarehouse (never just a hidden button -- security.md
// §1), so `isOwner` below only controls which CONTROLS render, not whether
// the server accepts the action.
// ---------------------------------------------------------------------------
export const dynamic = "force-dynamic";

export default async function MagasinsPage({
  params,
}: {
  params: Promise<{ structureId: string }>;
}) {
  const { structureId } = await params;

  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  let actor;
  try {
    actor = await resolveActor(session, structureId);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      redirect("/login");
    }
    if (err instanceof NotAMemberError) {
      notFound();
    }
    throw err;
  }

  if (!can(actor, "warehouse:write")) {
    return (
      <div className="min-h-screen bg-background px-4 py-8">
        <div className="mx-auto max-w-sm text-center">
          <p className="font-medium">{dict.warehouses.forbidden}</p>
          <a
            href={`/s/${structureId}/dashboard`}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {dict.team.backToDashboard}
          </a>
        </div>
      </div>
    );
  }

  const { structure, warehouses } = await withTenantSession(actor, async (ctx) => {
    const [row] = await ctx.db
      .select({ name: structures.name })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    const warehouses = await catalogService.listWarehouses(ctx, {});
    return { structure: row, warehouses };
  });

  if (!structure) {
    notFound();
  }

  return (
    <MagasinsClient
      structureId={structureId}
      structureName={structure.name}
      initialWarehouses={warehouses}
      isOwner={actor.role === "owner"}
    />
  );
}
