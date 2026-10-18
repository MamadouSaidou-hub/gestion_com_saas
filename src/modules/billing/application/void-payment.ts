import { assertCan, assertStoreAccess } from "@/modules/tenancy/permissions";
import { requireStepUp } from "@/modules/tenancy/step-up";
import { getStructureSettings } from "@/modules/tenancy/structure-settings";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto } from "@/platform/dto/money";
import { salesService } from "@/modules/sales";
import { PaymentNotFoundError, PaymentAlreadyVoidedError, InvalidPaymentInputError } from "../domain/errors";
import type { PaymentRepository, InvoiceRepository } from "./ports";
import type { PaymentDto } from "./dto";
import { toPaymentDto } from "./mappers";

export interface VoidPaymentRepos {
  paymentRepo: PaymentRepository;
  invoiceRepo: InvoiceRepository;
}

// ---------------------------------------------------------------------------
// voidPayment -- reverses a payment's effect on whatever it paid down
// (the sale directly, and/or the invoice it was allocated against, if
// any), then marks it voided. Top-level use case, own transaction.
//
// C1 fix (security-reviewer): `markVoided` is the FIRST atomic write, not
// the last. It is conditional on `voided_at IS NULL` in its own SQL
// statement, so it acts as the ARBITER -- exactly one of two concurrent
// voidPayment calls for the SAME payment can ever win it. The sale/
// invoice reversal only happens AFTER winning that gate, which is what
// guarantees "two concurrent voids debit the balance once, not twice":
// the previous version checked `voidedAt` with a plain SELECT at the top
// (no lock), so both concurrent calls could pass it and both apply the
// reversal before either one reached the (also non-atomic, at the time)
// final write.
// ---------------------------------------------------------------------------
export async function voidPayment(
  ctx: TenantSessionContext,
  paymentId: string,
  repos: VoidPaymentRepos
): Promise<PaymentDto> {
  assertCan(ctx.actor, "payment:void");

  const payment = await repos.paymentRepo.findById(ctx, paymentId);
  if (!payment) {
    throw new PaymentNotFoundError(paymentId);
  }

  // multi-store: RLS's floor already hides a payment from another store
  // from a gerant (findById above would have returned null); this is the
  // app-layer ceiling restated explicitly, same defense-in-depth
  // discipline as every other store-scoped write in this codebase. A NULL
  // warehouseId (the documented edge case in db/README entry 2x) is only
  // ever reachable by an unscoped actor in the first place, so it never
  // reaches this check for a gerant.
  if (payment.warehouseId !== null) {
    assertStoreAccess(ctx.actor, payment.warehouseId);
  }

  // H4 fix (security-reviewer, High): `structure_settings.sod_threshold_minor`
  // was read by NO code -- the same actor could record a payment then
  // void it with no second validator, regardless of amount. NULL
  // threshold = separation of duties disabled (the approved default, a
  // one-person shop is unaffected). `requireStepUp` throws today (no OTP
  // provider yet, D5) -- fail-closed is correct until one exists.
  const settings = await getStructureSettings(ctx);
  if (settings.sodThresholdMinor !== null && payment.amountMinor >= settings.sodThresholdMinor) {
    await requireStepUp(ctx.actor, "payment:void");
  }

  // The arbiter: wins or loses atomically. A losing call (payment already
  // voided, by this check or a concurrent one) stops here -- it never
  // touches the sale/invoice balance.
  const voided = await repos.paymentRepo.markVoided(ctx, paymentId, new Date());
  if (!voided) {
    throw new PaymentAlreadyVoidedError(paymentId);
  }

  if (payment.saleId) {
    await salesService.recordPaymentProgress(ctx, {
      saleId: payment.saleId,
      deltaMinor: -payment.amountMinor,
    });
  }

  const allocation = await repos.paymentRepo.findAllocationByPaymentId(ctx, paymentId);
  if (allocation) {
    const updatedInvoice = await repos.invoiceRepo.updatePaymentProgress(ctx, allocation.invoiceId, {
      deltaMinor: -allocation.amountMinor,
    });
    if (!updatedInvoice) {
      // Should never legitimately happen for a payment that was
      // correctly allocated in the first place -- fail closed rather
      // than silently clamp a potential accounting inconsistency to 0
      // (the previous version did exactly that).
      throw new InvalidPaymentInputError(
        "Could not reverse this payment's invoice allocation -- the invoice's paid amount would go out of bounds."
      );
    }
  }

  await ctx.audit.append({
    action: "payment.voided",
    targetType: "payment",
    targetId: paymentId,
    payload: {
      saleId: payment.saleId,
      amountMinor: moneyToDto(payment.amountMinor),
    },
  });

  return toPaymentDto(voided);
}
