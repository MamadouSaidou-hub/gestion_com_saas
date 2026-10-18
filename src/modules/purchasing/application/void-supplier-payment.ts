import { sql } from "drizzle-orm";
import { assertCan, storeScopeFor } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyToDto } from "@/platform/dto/money";
import { applyAtomicBoundedDelta } from "@/platform/money/atomic-delta";
import {
  SupplierPaymentNotFoundError,
  SupplierPaymentAlreadyVoidedError,
  StoreScopedActorCannotTouchSupplierDebtError,
  InvalidSupplierPaymentInputError,
} from "../domain/errors";
import type { SupplierPaymentDto } from "./dto";
import type { SupplierPaymentRepository } from "./ports";
import { toSupplierPaymentDto } from "./mappers";

// ---------------------------------------------------------------------------
// voidSupplierPayment -- top-level use case, own transaction.
//
// Sensitive action (D3) -- always audited.
//
// The UPDATE is the arbiter (C1 fix, the exact bug named in the brief):
// `markVoided` is conditional on `voided_at IS NULL` in its own SQL
// statement, mirroring billing's markVoided. Exactly one of two concurrent
// voidSupplierPayment calls for the SAME payment can ever win it; the
// delivery balance reversal only happens AFTER winning that gate, so two
// concurrent voids debit the balance once, never twice.
// ---------------------------------------------------------------------------
export async function voidSupplierPayment(
  ctx: TenantSessionContext,
  paymentId: string,
  repo: SupplierPaymentRepository
): Promise<SupplierPaymentDto> {
  assertCan(ctx.actor, "supplier_payment:void");

  if (storeScopeFor(ctx.actor) !== null) {
    throw new StoreScopedActorCannotTouchSupplierDebtError();
  }

  const payment = await repo.findById(ctx, paymentId);
  if (!payment) {
    throw new SupplierPaymentNotFoundError(paymentId);
  }

  // The arbiter: wins or loses atomically. A losing call stops here -- it
  // never touches the delivery balance.
  const voided = await repo.markVoided(ctx, paymentId, new Date());
  if (!voided) {
    throw new SupplierPaymentAlreadyVoidedError(paymentId);
  }

  const allocation = await repo.findAllocationByPaymentId(ctx, paymentId);
  if (allocation) {
    const updatedDelivery = await applyAtomicBoundedDelta<Record<string, unknown>>(ctx, {
      table: "supplier_deliveries",
      id: allocation.deliveryId,
      deltaColumn: "paid_minor",
      deltaMinor: -allocation.amountMinor,
      ceilingColumn: "total_minor",
      extraSet: {
        payment_status: sql`(case
          when paid_minor + ${-allocation.amountMinor} = 0 then 'unpaid'
          when paid_minor + ${-allocation.amountMinor} = total_minor then 'paid'
          else 'partial'
        end)::delivery_payment_status`,
      },
    });
    if (!updatedDelivery) {
      // Fail closed rather than silently clamp -- same discipline as
      // billing's voidPayment.
      throw new InvalidSupplierPaymentInputError(
        "Could not reverse this payment's delivery allocation -- the delivery's paid amount would go out of bounds."
      );
    }
  }

  await ctx.audit.append({
    action: "supplier_payment.voided",
    targetType: "supplier_payment",
    targetId: paymentId,
    payload: {
      supplierId: payment.supplierId,
      deliveryId: payment.deliveryId,
      amountMinor: moneyToDto(payment.amountMinor),
    },
  });

  return toSupplierPaymentDto(voided);
}
