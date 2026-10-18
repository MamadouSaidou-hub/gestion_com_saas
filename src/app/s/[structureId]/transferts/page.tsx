import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can, resolveStoreScope } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { catalogService } from "@/modules/catalog";
import { stockTransfersService } from "@/modules/stock-transfers";
import {
  createTransferAction,
  receiveTransferAction,
  cancelTransferAction,
} from "@/modules/stock-transfers/api/actions";
import { TransfersClient } from "./transfers-client";

// Gated, structure-scoped page: /s/[structureId]/transferts -- real
// transfers list + create/receive/cancel, wired to the stock-transfers
// module (this phase). Replaces nothing mocked (this screen did not exist
// before -- new nav entry, see nav-items.ts).
export const dynamic = "force-dynamic";

export default async function TransfertsPage({
  params,
  searchParams,
}: {
  params: Promise<{ structureId: string }>;
  searchParams: Promise<{ warehouseId?: string }>;
}) {
  const { structureId } = await params;
  const { warehouseId: requestedWarehouseId } = await searchParams;

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
    const [structureRow] = await ctx.db
      .select({ name: structures.name })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!structureRow) {
      return null;
    }

    const allWarehouses = await catalogService.listWarehouses(ctx, { activeOnly: true });
    const storeOptions = allWarehouses.filter((w) => w.kind === "store").map((w) => ({ id: w.id, name: w.name }));
    const storeScope = resolveStoreScope(
      actor,
      requestedWarehouseId && storeOptions.some((o) => o.id === requestedWarehouseId) ? requestedWarehouseId : null
    );
    const gerantStoreName = actor.warehouseId
      ? allWarehouses.find((w) => w.id === actor.warehouseId)?.name ?? null
      : null;

    const products = await catalogService.listProducts(ctx, { activeOnly: true });
    const transfers = await stockTransfersService.listTransfers(ctx, { storeScope });

    return {
      structureName: structureRow.name,
      storeOptions,
      gerantStoreName,
      storeScope,
      products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
      transfers,
      warehouseNameById: Object.fromEntries(allWarehouses.map((w) => [w.id, w.name])),
    };
  });

  if (!data) {
    notFound();
  }

  return (
    <TransfersClient
      structureId={structureId}
      structureName={data.structureName}
      storeOptions={data.storeOptions}
      gerantStoreName={data.gerantStoreName}
      currentWarehouseId={data.storeScope ?? data.storeOptions[0]?.id ?? null}
      products={data.products}
      transfers={data.transfers}
      warehouseNameById={data.warehouseNameById}
      canCreate={can(actor, "transfer:create")}
      canReceive={can(actor, "transfer:receive")}
      canCancel={can(actor, "transfer:cancel")}
      createTransferAction={createTransferAction.bind(null, structureId)}
      receiveTransferAction={receiveTransferAction.bind(null, structureId)}
      cancelTransferAction={cancelTransferAction.bind(null, structureId)}
    />
  );
}
