import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can, storeScopeFor } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { catalogService, CustomerNotFoundError } from "@/modules/catalog";
import { salesService } from "@/modules/sales";
import { recordPaymentAction } from "@/modules/billing/api";
import { rebatesService } from "@/modules/rebates";
import {
  createRebateScaleAction,
  updateRebateScaleTiersAction,
} from "@/modules/rebates/api/actions";
import { CustomerDetailClient } from "./customer-detail-client";

// Gated, structure-scoped page: /s/[structureId]/clients/[customerId] --
// a customer has NO home store (per the approved scoping decision), so a
// gerant's access is checked via "has activity in their store"
// (salesService.listCustomerIdsForStore), not a column on `customers`
// itself. Any mismatch -- unknown customer id OR a gerant requesting a
// customer with no activity in their store -- is a plain 404, same
// no-existence-oracle convention as the sale document page.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ structureId: string; customerId: string }>;
}) {
  const { structureId, customerId } = await params;

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

    const ownStore = storeScopeFor(actor);
    if (ownStore !== null) {
      const activeIds = await salesService.listCustomerIdsForStore(ctx, ownStore);
      if (!activeIds.includes(customerId)) {
        return null; // 404, not 403 -- no existence oracle
      }
    }

    let customer;
    try {
      customer = await catalogService.getCustomer(ctx, customerId);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return null;
      }
      throw err;
    }

    const sales = await salesService.listSales(ctx, { customerId });
    const openSales = sales.filter((s) => s.paymentStatus !== "paid");
    const rebateProgress = await rebatesService.getCustomerRebateProgress(ctx, customerId).catch(() => null);

    return {
      structureName: row.name,
      countryCode: row.countryCode,
      customer,
      sales,
      openSales,
      rebateProgress,
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <CustomerDetailClient
      structureId={structureId}
      structureName={data.structureName}
      currency={currencyForCountry(data.countryCode)}
      customer={data.customer}
      sales={data.sales}
      openSales={data.openSales}
      rebateProgress={data.rebateProgress}
      canConfigureRebate={can(actor, "rebate:write")}
      recordPaymentAction={recordPaymentAction.bind(null, structureId)}
      createRebateScaleAction={createRebateScaleAction.bind(null, structureId)}
      updateRebateScaleTiersAction={(scaleId, tiers) =>
        updateRebateScaleTiersAction(structureId, scaleId, tiers)
      }
    />
  );
}
