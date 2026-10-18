import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { InvalidSaleInputError, PaymentExceedsTotalError } from "../domain/errors";
import type { SalesRepository, SalePaymentStatus } from "./ports";

export interface RecordPaymentProgressInput {
  saleId: string;
  // Signed delta -- positive when recording a new payment, negative when
  // reversing one (voidPayment). Applied ATOMICALLY in SQL against the
  // row's current value (C1 fix) -- never read-then-written in JS.
  deltaMinor: bigint;
}

export interface PaymentProgressResult {
  saleId: string;
  paidMinor: bigint;
  totalMinor: bigint;
  paymentStatus: SalePaymentStatus;
}

// Ctx-based primitive for billing's recordPayment/voidPayment, same
// convention as inventory's applyStockOut: no `assertCan` here (the
// caller already checked `payment:record`/`payment:void`), no transaction
// of its own.
export async function recordPaymentProgress(
  ctx: TenantSessionContext,
  input: RecordPaymentProgressInput,
  repo: SalesRepository
): Promise<PaymentProgressResult> {
  // Existence check only -- NOT the value used for the bounds decision
  // (that happens atomically inside updatePaymentProgress's own SQL
  // statement, against whatever the row's value is AT THAT MOMENT, not
  // this possibly-stale read). This read exists purely to give "unknown
  // sale" a distinct error from "would overpay/underpay".
  const existing = await repo.findById(ctx, input.saleId);
  if (!existing) {
    throw new InvalidSaleInputError(`Unknown sale "${input.saleId}".`);
  }

  const updated = await repo.updatePaymentProgress(ctx, input.saleId, { deltaMinor: input.deltaMinor });
  if (!updated) {
    // The row existed a moment ago (checked above); rowCount = 0 here
    // means the atomic bounds check rejected this delta against the
    // CURRENT (possibly concurrently-changed) value.
    throw new PaymentExceedsTotalError();
  }

  return {
    saleId: updated.id,
    paidMinor: updated.paidMinor,
    totalMinor: updated.totalMinor,
    paymentStatus: updated.paymentStatus,
  };
}
