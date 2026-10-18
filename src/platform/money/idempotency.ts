// ---------------------------------------------------------------------------
// Shared idempotency-key + request-fingerprint resolution primitive.
//
// Pattern used everywhere a money-affecting write must be safe to retry
// (confirmSale, createTransfer, billing's recordPayment, and now
// purchasing's recordDelivery / recordSupplierPayment):
//   1. Try to INSERT the row with `ON CONFLICT (structure_id,
//      idempotency_key) DO NOTHING RETURNING *` -- the arbiter. A row only
//      becomes visible to a LATER call once the transaction that inserted
//      it has committed, so "zero rows returned" always means "a FULLY
//      applied write already exists for this key", never a half-finished
//      one from a still-in-flight transaction.
//   2. If the insert won the race, proceed with the side effects.
//   3. If it lost (conflict), re-SELECT by key. If nothing is found, a
//      concurrent attempt inserted then rolled back -- safe to tell the
//      caller to retry. If found, compare the stored request fingerprint:
//      a MATCH means this is a legitimate replay (return the existing
//      result, no second side effect, no second audit entry); a MISMATCH
//      means the same key was reused for a DIFFERENT payload, which must
//      be rejected rather than silently returning the wrong row (the H1
//      lesson from sales' confirmSale).
//
// This file factors steps 2-3 (the "what to do with a conflict" decision)
// into one function so every caller's replay-branch is provably identical.
// Step 1 itself stays in each repository (the INSERT shape differs per
// table), but it ends by handing EITHER the inserted row OR nothing to
// `resolveIdempotentWrite`, which is where the actual decision lives.
// ---------------------------------------------------------------------------

export class IdempotencyKeyReusedWithDifferentPayloadError extends Error {
  constructor(context: string) {
    super(
      `This idempotency key was already used for a different ${context} -- generate a new key for this request.`
    );
    this.name = "IdempotencyKeyReusedWithDifferentPayloadError";
  }
}

export class IdempotencyRaceLostError extends Error {
  constructor(context: string) {
    super(
      `Could not create or find the ${context} for this idempotency key -- a concurrent attempt likely rolled back; retry.`
    );
    this.name = "IdempotencyRaceLostError";
  }
}

export interface IdempotentReplayLookup<Existing> {
  findByIdempotencyKey(idempotencyKey: string): Promise<Existing | null>;
}

/**
 * Resolves what to return when the "try insert" step reported a conflict
 * (inserted === null). Generic over the existing row's shape; the caller
 * supplies how to read its stored fingerprint and how to look it up again.
 */
export async function resolveIdempotentReplay<Existing>(
  idempotencyKey: string,
  contextLabel: string,
  requestFingerprint: string,
  getStoredFingerprint: (existing: Existing) => string,
  lookup: IdempotentReplayLookup<Existing>
): Promise<Existing> {
  const existing = await lookup.findByIdempotencyKey(idempotencyKey);
  if (!existing) {
    throw new IdempotencyRaceLostError(contextLabel);
  }
  if (getStoredFingerprint(existing) !== requestFingerprint) {
    throw new IdempotencyKeyReusedWithDifferentPayloadError(contextLabel);
  }
  return existing;
}
