import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { catalogService } from "@/modules/catalog";
import { purchasingService } from "@/modules/purchasing";
import { createSupplierAction } from "@/modules/catalog/api/actions";
import { SupplierListClient } from "./supplier-list-client";

// Gated, structure-scoped page: /s/[structureId]/fournisseurs -- REAL
// supplier list + tenant-level debt (purchasingService.getSupplierDebt,
// deliberately NOT store-scoped -- see db/README entry 2y). The mock
// (mock-suppliers.ts) has been removed; this is the real `suppliers` table
// via catalogService.listSuppliers.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function FournisseursPage({
  params,
  searchParams,
}: {
  params: Promise<{ structureId: string }>;
  searchParams: Promise<{ search?: string }>;
}) {
  const { structureId } = await params;
  const { search } = await searchParams;

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

  const data = await withTenantSession(actor, async (ctx) => {
    const [row] = await ctx.db
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!row) {
      return null;
    }

    const suppliers = await catalogService.listSuppliers(ctx, { search });
    const debts = await Promise.all(suppliers.map((s) => purchasingService.getSupplierDebt(ctx, s.id)));
    const debtBySupplierId = new Map(debts.map((d) => [d.supplierId, d.debtMinor]));

    return {
      structureName: row.name,
      countryCode: row.countryCode,
      suppliers: suppliers.map((s) => ({ ...s, debtMinor: debtBySupplierId.get(s.id) ?? "0" })),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <SupplierListClient
      structureId={structureId}
      structureName={data.structureName}
      currency={currencyForCountry(data.countryCode)}
      suppliers={data.suppliers}
      canCreate={can(actor, "supplier:write")}
      createSupplierAction={createSupplierAction.bind(null, structureId)}
    />
  );
}
