import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { InsertSalePaymentInput, PaymentRecord, PaymentRepository } from "./ports";

// Ctx-based primitive, no transaction of its own -- confirmSale (sales
// module) calls this with its own ctx to record the payment collected at
// confirmation time, in the SAME transaction as the sale/stock/ticket
// writes. NOT the standalone "pay off a credit sale later" use case (that
// is a separate, independently-permissioned use case for a future step).
export async function recordSalePayment(
  ctx: TenantSessionContext,
  input: InsertSalePaymentInput,
  repo: PaymentRepository
): Promise<PaymentRecord> {
  return repo.insertForSale(ctx, input);
}
