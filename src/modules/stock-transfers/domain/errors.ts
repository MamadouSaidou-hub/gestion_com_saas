// Pure domain errors for the stock-transfers module (transfers + physical
// counts, sharing one module since they share one schema file --
// stock-transfers.ts, migration 0014) -- no drizzle, no Next imports.

export class InvalidTransferInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransferInputError";
  }
}

export class TransferNotFoundError extends Error {
  constructor(transferId: string) {
    super(`Transfer "${transferId}" was not found.`);
    this.name = "TransferNotFoundError";
  }
}

// The UPDATE-as-arbiter guard (`WHERE status = 'in_transit' RETURNING *`,
// rowCount 0 => this) -- same lesson as billing's markVoided. Covers BOTH
// "already received" and "already cancelled" (and "doesn't exist", which
// the caller tells apart by a prior findById only for a friendlier
// message -- the guard itself does not need to distinguish).
export class TransferNotInTransitError extends Error {
  constructor(transferId: string) {
    super(`Transfer "${transferId}" is not in transit (already received or cancelled).`);
    this.name = "TransferNotInTransitError";
  }
}

// A replayed idempotency key whose request fingerprint does NOT match the
// original request -- same H1-style defense as sales' confirmSale.
export class TransferIdempotencyKeyReuseError extends Error {
  constructor() {
    super(
      "This idempotency key was already used for a different transfer -- generate a new key for this transfer."
    );
    this.name = "TransferIdempotencyKeyReuseError";
  }
}

export class InvalidStockCountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStockCountInputError";
  }
}

export class StockCountNotFoundError extends Error {
  constructor(stockCountId: string) {
    super(`Stock count "${stockCountId}" was not found.`);
    this.name = "StockCountNotFoundError";
  }
}

// Same UPDATE-as-arbiter guard as TransferNotInTransitError, for
// `WHERE status = 'draft' RETURNING *` on validate/cancel.
export class StockCountNotDraftError extends Error {
  constructor(stockCountId: string) {
    super(`Stock count "${stockCountId}" is not a draft (already validated or cancelled).`);
    this.name = "StockCountNotDraftError";
  }
}

export class StockCountIdempotencyKeyReuseError extends Error {
  constructor() {
    super(
      "This idempotency key was already used for a different stock count -- generate a new key for this count."
    );
    this.name = "StockCountIdempotencyKeyReuseError";
  }
}
