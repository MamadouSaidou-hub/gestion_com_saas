import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { deliveryRepository } from "./infrastructure/delivery-repository";
import { supplierPaymentRepository } from "./infrastructure/supplier-payment-repository";
import * as useCases from "./application";
import type {
  RecordDeliveryInput,
  RecordSupplierPaymentInput,
  ListDeliveriesFilter,
} from "./application";

// ---------------------------------------------------------------------------
// purchasing/index.ts -- the ONLY surface another module is allowed to
// import from. Composition root wiring the concrete (drizzle) repositories
// into the pure use cases.
//
// `sumDeliveredQuantitySince` is exposed here specifically so `rebates`
// (supplier-side cyclic rebate) can read "units delivered since the
// scale's cycle_started_at" WITHOUT importing @/db/schema/purchasing
// directly (cross-module ESLint boundary rule) and WITHOUT purchasing
// importing rebates back (which would be a module cycle) -- see
// record-delivery.ts's header comment for how the two are still composed
// inside ONE transaction from the api/ Server Action layer.
// ---------------------------------------------------------------------------
export const purchasingService = {
  recordDelivery: (ctx: TenantSessionContext, input: RecordDeliveryInput) =>
    useCases.recordDelivery(ctx, input, deliveryRepository),
  recordSupplierPayment: (ctx: TenantSessionContext, input: RecordSupplierPaymentInput) =>
    useCases.recordSupplierPayment(ctx, input, {
      paymentRepo: supplierPaymentRepository,
      deliveryRepo: deliveryRepository,
    }),
  voidSupplierPayment: (ctx: TenantSessionContext, paymentId: string) =>
    useCases.voidSupplierPayment(ctx, paymentId, supplierPaymentRepository),
  listDeliveries: (ctx: TenantSessionContext, filter: ListDeliveriesFilter) =>
    useCases.listDeliveries(ctx, filter, deliveryRepository),
  getSupplierDebt: (ctx: TenantSessionContext, supplierId: string) =>
    useCases.getSupplierDebt(ctx, supplierId, deliveryRepository),
  getTotalSupplierDebt: (ctx: TenantSessionContext) =>
    useCases.getTotalSupplierDebt(ctx, deliveryRepository),
  // Read-only cross-module primitive for rebates -- see header comment.
  sumDeliveredQuantitySince: (ctx: TenantSessionContext, supplierId: string, sinceExclusive: Date) =>
    deliveryRepository.sumDeliveredQuantitySince(ctx, supplierId, sinceExclusive),
};

export type {
  RecordDeliveryInput,
  RecordDeliveryLineInput,
  DeliveryDto,
  DeliveryLineDto,
  RecordSupplierPaymentInput,
  SupplierPaymentDto,
  SupplierPaymentMethod,
  SupplierDebtDto,
  SupplierDebtTotalDto,
  ListDeliveriesFilter,
  DeliveryPaymentStatus,
} from "./application";
export {
  InvalidDeliveryInputError,
  DeliveryNotFoundError,
  DeliveryIdempotencyKeyReuseError,
  InvalidSupplierPaymentInputError,
  SupplierPaymentNotFoundError,
  SupplierPaymentAlreadyVoidedError,
  StoreScopedActorCannotTouchSupplierDebtError,
} from "./domain/errors";
