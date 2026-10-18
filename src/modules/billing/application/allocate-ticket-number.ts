import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { DocumentCounterRepository } from "./ports";

export async function allocateTicketNumber(
  ctx: TenantSessionContext,
  fiscalYear: number,
  repo: DocumentCounterRepository
): Promise<bigint> {
  return repo.allocateNext(ctx, "ticket", fiscalYear);
}
