// Pure domain errors for the sales module -- no drizzle, no Next imports.

export class InvalidSaleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSaleInputError";
  }
}

// A line references a product that is archived (is_active = false) or
// whose currency does not match the sale's currency (which must match the
// structure's single currency per D8 -- no multi-currency intra-tenant).
export class ProductNotSellableError extends Error {
  constructor(public readonly productId: string, reason: "inactive" | "currency_mismatch") {
    super(
      reason === "inactive"
        ? `Product "${productId}" is archived and cannot be sold.`
        : `Product "${productId}"'s currency does not match this sale's currency.`
    );
    this.name = "ProductNotSellableError";
  }
}

// ANY unpaid balance -- a zero-payment credit sale OR a partial payment --
// was requested with no identified customer. Corrected (coordinator
// feedback): an earlier version of this rule only guarded the partial
// case, which was an unintentional gap, not a deliberate asymmetry -- a
// fully-unpaid sale opens a receivable for the WHOLE total, which is
// exactly the case a customer-less receivable must never be allowed to
// exist for. Only a fully-paid sale (no balance left) may be anonymous.
export class AnonymousCreditSaleError extends Error {
  constructor() {
    super(
      "A sale with any unpaid balance (zero payment or partial payment) must have an identified customer -- no receivable against an anonymous walk-in."
    );
    this.name = "AnonymousCreditSaleError";
  }
}

export class PaymentExceedsTotalError extends Error {
  constructor() {
    super("The payment amount cannot exceed the sale's total.");
    this.name = "PaymentExceedsTotalError";
  }
}

// H1 (security-reviewer, High): the idempotency key was reused with a
// DIFFERENT request payload (different cart/customer/payment) than the
// one that originally claimed it. Never return the original sale in this
// case -- that would let a replayed key silently substitute a different,
// already-settled sale for whatever the cashier actually just rang up.
// Non-retryable: resending the SAME mismatched key will never succeed:
// the caller must generate a NEW idempotency key for this new cart.
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super(
      "This idempotency key was already used for a different sale (different cart, customer, or payment) -- generate a new key for this sale."
    );
    this.name = "IdempotencyKeyReuseError";
  }
}

export class DiscountLimitExceededError extends Error {
  constructor(maxPct: string) {
    super(`This discount exceeds the structure's configured maximum (${maxPct}%).`);
    this.name = "DiscountLimitExceededError";
  }
}
