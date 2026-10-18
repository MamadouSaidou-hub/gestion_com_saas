// Pure domain errors for the purchasing module (supplier deliveries +
// supplier payments, migration 0015) -- no drizzle, no Next imports.

export class InvalidDeliveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeliveryInputError";
  }
}

export class DeliveryNotFoundError extends Error {
  constructor(deliveryId: string) {
    super(`Delivery "${deliveryId}" was not found.`);
    this.name = "DeliveryNotFoundError";
  }
}

// H1-style defense, same as sales' confirmSale / transfers' createTransfer:
// a replayed idempotency key whose request fingerprint does NOT match the
// original request must be rejected, not silently resolved to the
// original delivery.
export class DeliveryIdempotencyKeyReuseError extends Error {
  constructor() {
    super(
      "This idempotency key was already used for a different delivery -- generate a new key for this delivery."
    );
    this.name = "DeliveryIdempotencyKeyReuseError";
  }
}

export class InvalidSupplierPaymentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSupplierPaymentInputError";
  }
}

export class SupplierPaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Supplier payment "${paymentId}" was not found.`);
    this.name = "SupplierPaymentNotFoundError";
  }
}

export class SupplierPaymentAlreadyVoidedError extends Error {
  constructor(paymentId: string) {
    super(`Supplier payment "${paymentId}" has already been voided.`);
    this.name = "SupplierPaymentAlreadyVoidedError";
  }
}

// Product decision: supplier debt is consolidated at TENANT level --
// supplier_payments carries no warehouseId, so a store-scoped actor
// ("gerant") must never record/void one, regardless of the role-level
// permission (see permissions.ts's comment on supplier_payment:record/void).
export class StoreScopedActorCannotTouchSupplierDebtError extends Error {
  constructor() {
    super(
      "Supplier debt is consolidated at tenant level -- a store-scoped member cannot record or void a supplier payment."
    );
    this.name = "StoreScopedActorCannotTouchSupplierDebtError";
  }
}
