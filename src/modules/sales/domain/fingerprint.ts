import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// H1 fix (security-reviewer, High): a request fingerprint, stored on the
// sale at first confirmation and re-checked on every idempotency-key
// replay. Pure, deterministic, no DB -- same inputs always produce the
// same hash regardless of ordering (lines are sorted before hashing), so
// a client resending the EXACT same cart under the same key always
// matches, while a DIFFERENT cart under a reused key never does.
// ---------------------------------------------------------------------------

export interface FingerprintLineInput {
  productId: string;
  quantity: string;
  discountMinor?: string;
}

export interface FingerprintPaymentInput {
  method: string;
  amountMinor?: string;
  full?: boolean;
  reference?: string | null;
}

export interface FingerprintInput {
  warehouseId: string;
  customerId: string | null;
  currencyCode: string;
  lines: FingerprintLineInput[];
  payment?: FingerprintPaymentInput | null;
}

export function computeRequestFingerprint(input: FingerprintInput): string {
  const sortedLines = [...input.lines]
    .map((l) => `${l.productId}:${l.quantity}:${l.discountMinor ?? "0"}`)
    .sort()
    .join(",");
  const paymentPart = input.payment
    ? `${input.payment.method}:${input.payment.full ? "full" : input.payment.amountMinor ?? ""}:${input.payment.reference ?? ""}`
    : "none";
  // L-f fix (security-reviewer follow-up): `currencyCode` included for
  // completeness -- confirmSale already rejects a currency mismatch
  // against the product's own currency before this point, so this isn't
  // closing an exploitable gap today, but the fingerprint should cover
  // every field that actually describes "what was rung up" so a future
  // change elsewhere can't silently make two different requests collide.
  const raw = `${input.warehouseId}|${input.customerId ?? ""}|${input.currencyCode}|${sortedLines}|${paymentPart}`;
  return createHash("sha256").update(raw).digest("hex");
}
