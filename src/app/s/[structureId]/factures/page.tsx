import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { billingService } from "@/modules/billing";
import { catalogService } from "@/modules/catalog";
import { InvoiceListClient } from "./invoice-list-client";

// Gated, structure-scoped page: /s/[structureId]/factures -- REAL
// invoices (billingService.listInvoices), reconciled with the "tickets by
// default, invoice on demand" model: this screen only ever shows
// documents that were actually ISSUED on demand (issueInvoiceForSale), not
// every confirmed sale -- most sales never show up here at all, by
// design. The mock data this screen used to run on has been removed.
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

  const data = await withTenantSession(actor, async (ctx) => {
    const [row] = await ctx.db
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!row) {
      return null;
    }

    const invoices = await billingService.listInvoices(ctx, {});
    const customerIds = Array.from(
      new Set(invoices.map((inv) => inv.customerId).filter((id): id is string => id !== null))
    );
    const customers = customerIds.length
      ? await catalogService.listCustomers(ctx, { ids: customerIds })
      : [];
    const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

    return {
      structureName: row.name,
      countryCode: row.countryCode,
      invoices: invoices.map((inv) => ({
        ...inv,
        customerName: inv.customerId ? customerNameById.get(inv.customerId) ?? "Client" : "Client comptant",
      })),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <InvoiceListClient
      structureId={structureId}
      structureName={data.structureName}
      currency={currencyForCountry(data.countryCode)}
      invoices={data.invoices}
    />
  );
}
