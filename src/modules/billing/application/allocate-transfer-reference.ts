import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { DocumentCounterRepository } from "./ports";

// Gapless numbering for stock_transfers.reference -- its OWN
// (structure, docType='transfer', fiscalYear) sequence, never shared with
// tickets/invoices (same "late lock, serializes the tenant" lock pattern as
// allocateTicketNumber -- see document-counter-repository.ts).
export async function allocateTransferReference(
  ctx: TenantSessionContext,
  fiscalYear: number,
  repo: DocumentCounterRepository
): Promise<bigint> {
  return repo.allocateNext(ctx, "transfer", fiscalYear);
}
