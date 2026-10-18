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
import { TeamListClient } from "./team-list-client";

// Gated, structure-scoped page: /s/[structureId]/parametres/equipe. Same
// resolveActor() pattern as the other screens. Unlike produits/fournisseurs/
// factures/stocks (any active member can view), this screen DOES deny
// access to roles without a real reason to see the full member roster:
// `settings:write` (owner/manager, who manage the team) or `audit:read`
// (auditor, who needs to know who holds what role). cashier/stock_keeper/
// accountant get a fail-closed "forbidden" message, not a 404 (they ARE
// members of the structure -- just not of this screen's audience) and not a
// silent redirect (which would hide WHY the link didn't work).
export const dynamic = "force-dynamic";

export default async function EquipePage({
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

  const structure = await withTenantSession(actor, async ({ db }) => {
    const [row] = await db
      .select({ name: structures.name })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    return row;
  });

  if (!structure) {
    notFound();
  }

  const canViewTeam = can(actor, "settings:write") || can(actor, "audit:read");
  if (!canViewTeam) {
    return (
      <div className="min-h-screen bg-background px-4 py-8">
        <div className="mx-auto max-w-sm text-center">
          <p className="font-medium">{dict.team.forbidden}</p>
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

  return (
    <TeamListClient
      structureId={structureId}
      structureName={structure.name}
      canInvite={can(actor, "member:invite")}
    />
  );
}
