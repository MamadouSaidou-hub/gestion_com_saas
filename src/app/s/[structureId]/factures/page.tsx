import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { InvoiceListClient } from "./invoice-list-client";

// Gated, structure-scoped page: /s/[structureId]/factures. Same
// resolveActor() pattern as the other screens. As with suppliers/products,
// there is no dedicated "invoice:read" permission yet (only `invoice:issue`,
// which is a WRITE permission) -- any active member may view the invoice
// list; issuing a real invoice is left to the real billing module, not
// exposed here as an ungated action.
//
// DESIGN MOCKUP NOTICE: the invoice list is sample data, not a real
// `invoices` query -- that module doesn't exist yet (D4).
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function FacturesPage({
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
    <InvoiceListClient
      structureId={structureId}
      structureName={structure.name}
      currency={currencyForCountry(structure.countryCode)}
    />
  );
}
