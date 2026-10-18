import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can, resolveStoreScope } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { catalogService } from "@/modules/catalog";
import { salesService } from "@/modules/sales";
import { billingService } from "@/modules/billing";
import { createCustomerAction } from "@/modules/catalog/api/actions";
import { ClientsListClient } from "./clients-list-client";

// Gated, structure-scoped page: /s/[structureId]/clients -- real customers
// + their outstanding balance (REUSED from billingService.getReceivables'
// own two sources, grouped per customer -- see get-receivables-by-customer.ts,
// never recomputed here). Store scoping composition happens HERE, at the
// page level, because catalog cannot depend on sales (module cycle) --
// see sales/index.ts's comment on listCustomerIdsForStore.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function ClientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ structureId: string }>;
  searchParams: Promise<{ search?: string; warehouseId?: string }>;
}) {
  const { structureId } = await params;
  const { search, warehouseId: requestedWarehouseId } = await searchParams;

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

    const storeScope = resolveStoreScope(actor, requestedWarehouseId ?? null);
    const ids = storeScope ? await salesService.listCustomerIdsForStore(ctx, storeScope) : undefined;

    const [customers, receivables] = await Promise.all([
      catalogService.listCustomers(ctx, { activeOnly: true, search, ids }),
      billingService.getReceivablesByCustomer(ctx, storeScope),
    ]);
    const receivableByCustomerId = new Map(receivables.map((r) => [r.customerId, r]));

    return {
      structureName: row.name,
      countryCode: row.countryCode,
      customers: customers.map((c) => ({
        ...c,
        outstandingMinor: receivableByCustomerId.get(c.id)?.outstandingMinor ?? "0",
        overdueMinor: receivableByCustomerId.get(c.id)?.overdueMinor ?? "0",
      })),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <ClientsListClient
      structureId={structureId}
      structureName={data.structureName}
      currency={currencyForCountry(data.countryCode)}
      customers={data.customers}
      canCreate={can(actor, "customer:write")}
      canExport={can(actor, "report:export")}
      createCustomerAction={createCustomerAction.bind(null, structureId)}
    />
  );
}
