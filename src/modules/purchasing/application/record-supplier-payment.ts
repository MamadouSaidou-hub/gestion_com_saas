import { z } from "zod";
import { assertCan, storeScopeFor } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { moneyFromDto, moneyToDto } from "@/platform/dto/money";
import { catalogService } from "@/modules/catalog";
import { applyAtomicBoundedDelta } from "@/platform/money/atomic-delta";
import { sql } from "drizzle-orm";
import {
  InvalidSupplierPaymentInputError,
  StoreScopedActorCannotTouchSupplierDebtError,
  DeliveryNotFoundError,
} from "../domain/errors";
import type { RecordSupplierPaymentInput, SupplierPaymentDto } from "./dto";
import type { DeliveryRepository, SupplierPaymentRepository } from "./ports";
import { toSupplierPaymentDto } from "./mappers";

const recordSupplierPaymentSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  supplierId: z.uuid(),
  deliveryId: z.uuid().nullable().optional(),
  amountMinor: z.string().regex(/^\d+$/),
  method: z.enum(["cash", "mobile_money", "bank_transfer", "card", "other"]),
  reference: z.string().nullable().optional(),
});

export interface RecordSupplierPaymentRepos {
  paymentRepo: SupplierPaymentRepository;
  deliveryRepo: DeliveryRepository;
}

// ---------------------------------------------------------------------------
// recordSupplierPayment -- top-level use case, own transaction. Supplier
// debt is consolidated at TENANT level (product decision, db/README entry
// 2y): `supplier_payments` carries no warehouseId, so a store-scoped actor
// ("gerant") must be rejected outright, regardless of holding
// "supplier_payment:record" at the role-tier level -- there is no "Payer"
// button for a gerant in the UI, and this is the server-side ceiling for
// that same rule.
//
// C1 fix, done the SAME way as billing's invoice-repository (NOT a second,
// independently-drifting copy): `applyAtomicBoundedDelta` increments
// `supplier_deliveries.paid_minor` in ONE SQL statement against the row's
// CURRENT value, bounded between 0 and total_minor -- never a JS
// read-modify-write. This is what makes two concurrent supplier payments
// against the SAME delivery both land correctly (each one's delta is
// applied against whatever the other already committed), instead of one
// silently clobbering the other.
// ---------------------------------------------------------------------------
export async function recordSupplierPayment(
  ctx: TenantSessionContext,
  rawInput: RecordSupplierPaymentInput,
  repos: RecordSupplierPaymentRepos
): Promise<SupplierPaymentDto> {
  assertCan(ctx.actor, "supplier_payment:record");

  if (storeScopeFor(ctx.actor) !== null) {
    throw new StoreScopedActorCannotTouchSupplierDebtError();
  }

  const input = recordSupplierPaymentSchema.parse(rawInput);
  const amountMinor = moneyFromDto(input.amountMinor);
  if (amountMinor <= 0n) {
    throw new InvalidSupplierPaymentInputError("Payment amount must be strictly positive.");
  }

  // Re-verify the supplier exists in this tenant.
  await catalogService.getSupplier(ctx, input.supplierId);

  let delivery = null;
  if (input.deliveryId) {
    delivery = await repos.deliveryRepo.findById(ctx, input.deliveryId);
    if (!delivery) {
      throw new DeliveryNotFoundError(input.deliveryId);
    }
    if (delivery.supplierId !== input.supplierId) {
      throw new InvalidSupplierPaymentInputError(
        "This delivery does not belong to the specified supplier."
      );
    }
  }

  const inserted = await repos.paymentRepo.tryInsert(ctx, {
    supplierId: input.supplierId,
    deliveryId: input.deliveryId ?? null,
    amountMinor,
    currencyCode: delivery?.currencyCode ?? "XOF",
    method: input.method,
    reference: input.reference ?? null,
    paidAt: new Date(),
    createdBy: ctx.actor.userId,
    idempotencyKey: input.idempotencyKey,
  });

  if (!inserted) {
    // Replay -- same reasoning as billing's recordPayment: the existing row
    // can only be visible here because a prior call already committed, so
    // whatever delivery progress it caused is already applied. No second
    // mutation, no second audit entry. Supplier payments carry no request
    // fingerprint column (mirrors billing's own `payments` table) -- the
    // idempotency key alone is the arbiter here, same as recordPayment.
    const existing = await repos.paymentRepo.findByIdempotencyKey(ctx, input.idempotencyKey);
    if (!existing) {
      throw new InvalidSupplierPaymentInputError(
        "Could not record or find the supplier payment for this idempotency key -- retry."
      );
    }
    return toSupplierPaymentDto(existing);
  }

  if (input.deliveryId && delivery) {
    const updatedDelivery = await applyAtomicBoundedDelta<{ payment_status: string }>(ctx, {
      table: "supplier_deliveries",
      id: input.deliveryId,
      deltaColumn: "paid_minor",
      deltaMinor: amountMinor,
      ceilingColumn: "total_minor",
      extraSet: {
        payment_status: sql`(case
          when paid_minor + ${amountMinor} = 0 then 'unpaid'
          when paid_minor + ${amountMinor} = total_minor then 'paid'
          else 'partial'
        end)::delivery_payment_status`,
      },
    });
    if (!updatedDelivery) {
      throw new InvalidSupplierPaymentInputError(
        "This payment would exceed the delivery's outstanding balance."
      );
    }
    await repos.paymentRepo.insertAllocation(ctx, {
      supplierPaymentId: inserted.id,
      deliveryId: input.deliveryId,
      amountMinor,
      currencyCode: delivery.currencyCode,
    });
  }

  // ids + amounts only -- no supplier name/phone (PII guard throws).
  await ctx.audit.append({
    action: "supplier_payment.recorded",
    targetType: "supplier_payment",
    targetId: inserted.id,
    payload: {
      supplierId: input.supplierId,
      deliveryId: input.deliveryId ?? null,
      amountMinor: moneyToDto(amountMinor),
      method: input.method,
      idempotencyKey: input.idempotencyKey,
    },
  });

  return toSupplierPaymentDto(inserted);
}
