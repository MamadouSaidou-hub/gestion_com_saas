import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { TransferDto } from "./dto";
import type { TransfersRepository, ListTransfersFilter } from "./ports";
import { toTransferDto } from "./mappers";

// Read side -- list headers (store-scoped by the RLS floor AND re-checked
// here via the required `storeScope` filter, resolved by the caller via
// `resolveStoreScope`, same convention as billing's listPayments). Lines
// are fetched per-transfer for the DTO -- bounded by `limit`, a transfer
// list is never expected to be large enough for this to be a real N+1 cost
// at this product's scale.
export async function listTransfers(
  ctx: TenantSessionContext,
  filter: ListTransfersFilter,
  repo: TransfersRepository
): Promise<TransferDto[]> {
  assertCan(ctx.actor, "transfer:read");
  const headers = await repo.list(ctx, filter);
  const dtos = await Promise.all(
    headers.map(async (header) => {
      const lines = await repo.listLines(ctx, header.id);
      return toTransferDto(header, lines, false);
    })
  );
  return dtos;
}

export async function getInTransitByProduct(
  ctx: TenantSessionContext,
  storeScope: string | null,
  repo: TransfersRepository
): Promise<Record<string, string>> {
  assertCan(ctx.actor, "stock:read");
  return repo.sumInTransitQuantityByProduct(ctx, storeScope);
}
