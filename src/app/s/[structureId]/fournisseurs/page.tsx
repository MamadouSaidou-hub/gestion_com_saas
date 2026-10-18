import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { SupplierListClient } from "./supplier-list-client";

// Gated, structure-scoped page: /s/[structureId]/fournisseurs. Same
// resolveActor() pattern as the dashboard/produits screens. There is no
// dedicated "supplier:read" permission in the current matrix (permissions.ts)
// -- as with the product catalog, any active member of the structure may
// VIEW the supplier list. No write action is exposed here: unlike
// product:write/stock:adjust, no permission models "supplier:write" yet, so
// rather than inventing an ungated action this screen stays read-only until
// the real fournisseurs module (and its permission) lands.
//
// DESIGN MOCKUP NOTICE: the supplier list is sample data, not a real
// `suppliers` query -- that module doesn't exist yet.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function FournisseursPage({
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
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    return row;
  });

  if (!structure) {
    notFound();
  }

  return (
    <SupplierListClient
      structureId={structureId}
      structureName={structure.name}
      currency={currencyForCountry(structure.countryCode)}
    />
  );
}
