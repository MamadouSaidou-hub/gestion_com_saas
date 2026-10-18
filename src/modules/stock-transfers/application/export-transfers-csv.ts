import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { listTransfers } from "./list-transfers";
import type { TransfersRepository, ListTransfersFilter } from "./ports";
import type { TransferDto } from "./dto";

// Same convention as sales'/inventory's CSV export wrappers.
export async function exportTransfersCsv(
  ctx: TenantSessionContext,
  filter: ListTransfersFilter,
  repo: TransfersRepository
): Promise<TransferDto[]> {
  assertCan(ctx.actor, "report:export");
  return listTransfers(ctx, filter, repo);
}
