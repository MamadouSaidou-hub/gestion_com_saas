// Pure domain errors for the billing module -- no drizzle, no Next imports.

export class SaleNotFoundError extends Error {
  constructor(saleId: string) {
    super(`Sale "${saleId}" was not found.`);
    this.name = "SaleNotFoundError";
  }
}

export class SaleNotConfirmedError extends Error {
  constructor(saleId: string) {
    super(`Sale "${saleId}" is not confirmed -- cannot issue an invoice or record a payment for it.`);
    this.name = "SaleNotConfirmedError";
  }
}

export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice "${invoiceId}" was not found.`);
    this.name = "InvoiceNotFoundError";
  }
}

export class PaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Payment "${paymentId}" was not found.`);
    this.name = "PaymentNotFoundError";
  }
}

export class PaymentAlreadyVoidedError extends Error {
  constructor(paymentId: string) {
    super(`Payment "${paymentId}" has already been voided.`);
    this.name = "PaymentAlreadyVoidedError";
  }
}

export class OverpaymentError extends Error {
  constructor() {
    super("This payment would exceed the outstanding balance.");
    this.name = "OverpaymentError";
  }
}

export class InvalidPaymentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymentInputError";
  }
}
