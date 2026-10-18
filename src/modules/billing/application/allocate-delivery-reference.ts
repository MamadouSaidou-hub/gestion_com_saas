import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { DocumentCounterRepository } from "./ports";

// Gapless numbering for supplier_deliveries.reference -- its OWN
// (structure, docType='delivery', fiscalYear) sequence (migration 0015's
// ALTER TYPE -- see db/README entry 2y), never shared with
// tickets/invoices/transfers.
export async function allocateDeliveryReference(
  ctx: TenantSessionContext,
  fiscalYear: number,
  repo: DocumentCounterRepository
): Promise<bigint> {
  return repo.allocateNext(ctx, "delivery", fiscalYear);
}
