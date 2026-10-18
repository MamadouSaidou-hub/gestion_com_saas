import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Request fingerprints -- H1-style defense (mirrors sales/domain/
// fingerprint.ts): stored at first confirmation, re-checked on every
// idempotency-key replay so a reused key with a DIFFERENT payload is
// rejected instead of silently returning the original row.
// ---------------------------------------------------------------------------

export interface TransferFingerprintLineInput {
  productId: string;
  quantity: string;
}

export interface TransferFingerprintInput {
  fromWarehouseId: string;
  toWarehouseId: string;
  lines: TransferFingerprintLineInput[];
}

export function computeTransferFingerprint(input: TransferFingerprintInput): string {
  const sortedLines = [...input.lines]
    .map((l) => `${l.productId}:${l.quantity}`)
    .sort()
    .join(",");
  const raw = `${input.fromWarehouseId}|${input.toWarehouseId}|${sortedLines}`;
  return createHash("sha256").update(raw).digest("hex");
}

export interface StockCountFingerprintInput {
  warehouseId: string;
  productIds: string[];
}

export function computeStockCountFingerprint(input: StockCountFingerprintInput): string {
  const sortedProductIds = [...input.productIds].sort().join(",");
  const raw = `${input.warehouseId}|${sortedProductIds}`;
  return createHash("sha256").update(raw).digest("hex");
}
