// ---------------------------------------------------------------------------
// Money DTO boundary.
//
// Every monetary column in this schema is `bigint` minor-unit (D8 -- never
// float/numeric for money). `bigint` is NOT JSON-serializable across the
// RSC/Server-Action boundary: Next.js' serialization for `"use server"`
// function returns and for data passed from a Server Component into a
// Client Component throws on a raw `bigint` value. This module is the one
// place that conversion happens, so every business module follows the same
// convention from the start instead of each one discovering the crash at
// runtime independently.
//
// Convention: `bigint` lives ONLY inside a `withTenantSession` transaction
// and the application/domain layers that operate on it. The moment a value
// is about to cross into a Server Action's return value, a DTO handed to a
// page/component, or JSON, it goes through `moneyToDto`. The moment a
// client-supplied amount comes back in (e.g. a form field, a retried POS
// payload), it goes through `moneyFromDto` before touching any domain logic
// -- never `BigInt(someUncheckedString)` ad hoc at a call site.
// ---------------------------------------------------------------------------

export type MoneyMinorDto = string;

export function moneyToDto(amountMinor: bigint): MoneyMinorDto {
  return amountMinor.toString();
}

const MINOR_AMOUNT_PATTERN = /^-?\d+$/;

export class InvalidMoneyDtoError extends Error {
  constructor(raw: string) {
    super(`"${raw}" is not a valid minor-unit money string (expected an integer, e.g. "125000").`);
    this.name = "InvalidMoneyDtoError";
  }
}

export function moneyFromDto(amountMinor: MoneyMinorDto): bigint {
  if (!MINOR_AMOUNT_PATTERN.test(amountMinor.trim())) {
    throw new InvalidMoneyDtoError(amountMinor);
  }
  return BigInt(amountMinor);
}
