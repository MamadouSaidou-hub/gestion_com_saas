import { createHash } from "node:crypto";

// H1-style defense (mirrors sales/domain/fingerprint.ts and
// stock-transfers/domain/fingerprint.ts): stored at first confirmation,
// re-checked on every idempotency-key replay.

export interface DeliveryFingerprintLineInput {
  productId: string;
  quantity: string;
  unitCostMinor: string;
}

export interface DeliveryFingerprintInput {
  supplierId: string;
  warehouseId: string;
  currencyCode: string;
  lines: DeliveryFingerprintLineInput[];
}

export function computeDeliveryFingerprint(input: DeliveryFingerprintInput): string {
  const sortedLines = [...input.lines]
    .map((l) => `${l.productId}:${l.quantity}:${l.unitCostMinor}`)
    .sort()
    .join(",");
  const raw = `${input.supplierId}|${input.warehouseId}|${input.currencyCode}|${sortedLines}`;
  return createHash("sha256").update(raw).digest("hex");
}
