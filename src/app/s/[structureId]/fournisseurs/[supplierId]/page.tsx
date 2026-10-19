import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can, resolveStoreScope, storeScopeFor } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { SupportedCurrency } from "@/lib/money";
import { catalogService, SupplierNotFoundError } from "@/modules/catalog";
import { purchasingService } from "@/modules/purchasing";
import { rebatesService } from "@/modules/rebates";
import {
  recordDeliveryAction,
  recordSupplierPaymentAction,
  voidSupplierPaymentAction,
} from "@/modules/purchasing/api/actions";
import {
  verifyRebateTierAction,
  createRebateScaleAction,
  updateRebateScaleTiersAction,
} from "@/modules/rebates/api/actions";
import { SupplierDetailClient } from "./supplier-detail-client";

// Gated, structure-scoped page: /s/[structureId]/fournisseurs/[supplierId].
// A gerant sees ONLY their store's deliveries (store-scoped) but still sees
// the TENANT-level debt figure (read-only, no "Payer" button -- see
// purchasing/application/record-supplier-payment.ts's header comment).
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function SupplierDetailPage({
  params,
}: {
  params: Promise<{ structureId: string; supplierId: string }>;
}) {
  const { structureId, supplierId } = await params;

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
    if (!row) return null;

    let supplier;
    try {
      supplier = await catalogService.getSupplier(ctx, supplierId);
    } catch (err) {
      if (err instanceof SupplierNotFoundError) return null;
      throw err;
    }

    const storeScope = resolveStoreScope(actor);
    const [debt, deliveries, products, rebateProgress, warehouses] = await Promise.all([
      purchasingService.getSupplierDebt(ctx, supplierId),
      purchasingService.listDeliveries(ctx, { supplierId, storeScope }),
      catalogService.listProducts(ctx, { activeOnly: true }),
      rebatesService.getSupplierRebateProgress(ctx, supplierId).catch(() => null),
      catalogService.listWarehouses(ctx, { activeOnly: true, kind: "store" }),
    ]);

    // The delivery form needs a default warehouse: a gerant's own store, or
    // (for an unscoped actor) the structure's default store -- never a
    // client-chosen value for a gerant (assertStoreAccess in recordDelivery
    // would reject a mismatch anyway; this is just picking a sane default).
    const defaultWarehouseId =
      storeScope ?? warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? null;

    return {
      structureName: row.name,
      countryCode: row.countryCode,
      supplier,
      debt,
      deliveries,
      products,
      rebateProgress,
      defaultWarehouseId,
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <SupplierDetailClient
      structureId={structureId}
      structureName={data.structureName}
      currency={currencyForCountry(data.countryCode)}
      supplier={data.supplier}
      debt={data.debt}
      deliveries={data.deliveries}
      products={data.products.map((p) => ({ id: p.id, name: p.name, sku: p.sku }))}
      rebateProgress={data.rebateProgress}
      defaultWarehouseId={data.defaultWarehouseId}
      canRecordDelivery={can(actor, "delivery:record")}
      canRecordPayment={can(actor, "supplier_payment:record") && storeScopeFor(actor) === null}
      canVoidPayment={can(actor, "supplier_payment:void") && storeScopeFor(actor) === null}
      canVerifyTier={can(actor, "rebate:grant")}
      canConfigureRebate={can(actor, "rebate:write")}
      recordDeliveryAction={recordDeliveryAction.bind(null, structureId)}
      recordSupplierPaymentAction={recordSupplierPaymentAction.bind(null, structureId)}
      voidSupplierPaymentAction={voidSupplierPaymentAction.bind(null, structureId)}
      verifyRebateTierAction={verifyRebateTierAction.bind(null, structureId, supplierId)}
      createRebateScaleAction={createRebateScaleAction.bind(null, structureId)}
      updateRebateScaleTiersAction={(scaleId, tiers) =>
        updateRebateScaleTiersAction(structureId, scaleId, tiers)
      }
    />
  );
}
