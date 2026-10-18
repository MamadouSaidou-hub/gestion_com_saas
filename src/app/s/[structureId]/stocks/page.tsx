import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { StockMovementsClient } from "./stock-movements-client";

// Gated, structure-scoped page: /s/[structureId]/stocks -- the stock
// MOVEMENT LEDGER (in/out history per product), distinct from the product
// catalog at /produits (current on-hand count + price). Same resolveActor()
// pattern as the other screens. Viewing the ledger has no dedicated
// "stock:read" permission either (same reasoning as produits); the
// "Enregistrer un mouvement" action IS gated below, via the real
// `stock:adjust` permission that already exists in the matrix.
//
// DESIGN MOCKUP NOTICE: the movement list is sample data, not a real
// `stock_movements` query (D9) -- that ledger doesn't exist yet.
export const dynamic = "force-dynamic";

export default async function StocksPage({
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

  return (
    <StockMovementsClient
      structureId={structureId}
      structureName={structure.name}
      canRecordMovement={can(actor, "stock:adjust")}
    />
  );
}
