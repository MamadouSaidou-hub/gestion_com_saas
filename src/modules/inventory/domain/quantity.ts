// ---------------------------------------------------------------------------
// Quantity value object.
//
// `numeric(18,4)` columns (stock_movements.quantity, stock_levels.quantity,
// sale_lines.quantity) come back from the `postgres` driver as STRINGS, not
// JS numbers -- and this project's money columns already forbid float
// arithmetic (D8); the same discipline applies to quantities. NEVER
// `Number()` a quantity anywhere in this codebase: this value object does
// every arithmetic operation on a fixed-point BigInt (scaled by 10_000,
// matching numeric(18,4)'s 4 decimal places), so there is no
// floating-point rounding anywhere in the inventory domain.
//
// Pure TS, no drizzle, no Next imports -- importable from any layer,
// including domain, and re-exported through this module's index.ts so
// other modules (sales, in a later step) can use it without reaching into
// `inventory/domain` directly.
// ---------------------------------------------------------------------------

const SCALE = 10_000n; // numeric(18,4) => 4 decimal places

export class InvalidQuantityError extends Error {
  constructor(raw: string) {
    super(
      `"${raw}" is not a valid quantity (expected a decimal string with up to 4 places, e.g. "12.5000").`
    );
    this.name = "InvalidQuantityError";
  }
}

const QUANTITY_STRING_PATTERN = /^(-?)(\d+)(?:\.(\d{0,4}))?$/;

export class Quantity {
  private constructor(private readonly scaled: bigint) {}

  static zero(): Quantity {
    return new Quantity(0n);
  }

  // Parses a numeric(18,4) string exactly as returned by the postgres
  // driver (e.g. "12.5000", "-3.2", "0"). Never pass a `number` here --
  // that would require the caller to have already done the float
  // conversion this value object exists to prevent.
  static fromString(raw: string): Quantity {
    const trimmed = raw.trim();
    const match = QUANTITY_STRING_PATTERN.exec(trimmed);
    if (!match) {
      throw new InvalidQuantityError(raw);
    }
    const [, sign, intPart, fracPartRaw] = match;
    const fracPart = (fracPartRaw ?? "").padEnd(4, "0");
    const magnitude = BigInt(intPart) * SCALE + BigInt(fracPart === "" ? "0" : fracPart);
    const value = sign === "-" ? -magnitude : magnitude;
    return new Quantity(value);
  }

  // For whole-unit counts constructed in application code or tests, where
  // there is no driver string to parse yet (e.g. "sell 3 units").
  static fromInt(value: number): Quantity {
    if (!Number.isInteger(value)) {
      throw new InvalidQuantityError(String(value));
    }
    return new Quantity(BigInt(value) * SCALE);
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.scaled + other.scaled);
  }

  subtract(other: Quantity): Quantity {
    return new Quantity(this.scaled - other.scaled);
  }

  negate(): Quantity {
    return new Quantity(-this.scaled);
  }

  isZero(): boolean {
    return this.scaled === 0n;
  }

  isNegative(): boolean {
    return this.scaled < 0n;
  }

  isPositive(): boolean {
    return this.scaled > 0n;
  }

  lessThan(other: Quantity): boolean {
    return this.scaled < other.scaled;
  }

  greaterThanOrEqual(other: Quantity): boolean {
    return this.scaled >= other.scaled;
  }

  equals(other: Quantity): boolean {
    return this.scaled === other.scaled;
  }

  // Fixed-point quantity x unit-minor-amount -> minor-unit bigint, rounded
  // HALF UP (never banker's rounding, never float) -- used by purchasing
  // (line_total_minor = quantity x unit_cost_minor) and rebates
  // (total_rebate_minor = counted_qty x rebate_per_unit_minor). `this.scaled`
  // is quantity x SCALE, so `this.scaled * unitMinor` is quantity x unitMinor
  // x SCALE; dividing back by SCALE with a pre-added half-scale numerator
  // rounds half up without ever going through a float.
  multiplyToMinor(unitMinor: bigint): bigint {
    const numerator = this.scaled * unitMinor;
    const half = SCALE / 2n;
    if (numerator >= 0n) {
      return (numerator + half) / SCALE;
    }
    return -((-numerator + half) / SCALE);
  }

  // Internal-ish accessor for pure-domain functions (e.g. CUMP valuation)
  // that need the scaled bigint directly, without re-parsing a string.
  // Deliberately on the instance rather than a free function, so a caller
  // can't construct a Quantity from an arbitrary bigint without going
  // through the validated factories above.
  toScaled(): bigint {
    return this.scaled;
  }

  // Serializes back to a numeric(18,4)-compatible string for writing to the
  // DB (drizzle's `numeric` column type expects/returns strings).
  toDbString(): string {
    const negative = this.scaled < 0n;
    const abs = negative ? -this.scaled : this.scaled;
    const intPart = abs / SCALE;
    const fracPart = abs % SCALE;
    return `${negative ? "-" : ""}${intPart.toString()}.${fracPart.toString().padStart(4, "0")}`;
  }

  toString(): string {
    return this.toDbString();
  }
}

export const QUANTITY_SCALE = SCALE;
