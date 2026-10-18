import { sql, type SQL } from "drizzle-orm";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// Shared "atomic bounded delta" primitive (D8 money discipline + the C1
// lesson from the security-reviewer's customer-side finding: a running
// total like `paid_minor` must be incremented in ONE SQL statement against
// the row's CURRENT value, never read-in-JS-then-write-back). Both the
// customer side (billing's invoices/sales paid_minor) and the supplier side
// (purchasing's supplier_deliveries paid_minor) run through this SAME
// function so they provably share the fix instead of carrying two
// independently-drifting copies of it.
//
// Table/column names are passed as plain strings and inlined via
// `sql.raw(...)` -- safe here because every caller in this codebase passes
// a hardcoded literal (never user input), exactly like drizzle's own
// generated SQL inlines identifiers. The WHERE clause's bounds check
// (`delta_column + :delta between 0 and ceiling_column`) is what makes two
// concurrent calls for the SAME row -- e.g. two concurrent supplier
// payments against the same delivery, or two concurrent voids of the same
// payment -- resolve to "at most one succeeds past the ceiling", not a lost
// update: Postgres serializes the two UPDATEs on the row's own lock, and
// the SECOND one re-evaluates the bounds check against the FIRST one's
// already-committed (or, if still in the same transaction, already
// locked/applied) value.
// ---------------------------------------------------------------------------

export interface AtomicBoundedDeltaInput {
  /** Bare table name, e.g. "supplier_deliveries". */
  table: string;
  /** Primary key column name, default "id". */
  idColumn?: string;
  id: string;
  /** Running-total column to increment, e.g. "paid_minor". */
  deltaColumn: string;
  deltaMinor: bigint;
  /** Column the new running total must not exceed (lower bound is always 0). */
  ceilingColumn: string;
  /**
   * Extra columns to SET in the same statement (e.g. a derived `status`
   * enum recomputed from the new total) -- each value is a fully-formed
   * `SQL` expression built by the caller (it may itself reference raw
   * column names via `sql.raw`, see invoice-repository.ts /
   * delivery-repository.ts for examples).
   */
  extraSet?: Record<string, SQL>;
}

export async function applyAtomicBoundedDelta<Row extends object>(
  ctx: TenantSessionContext,
  input: AtomicBoundedDeltaInput
): Promise<Row | null> {
  const idCol = input.idColumn ?? "id";
  const extraAssignments = Object.entries(input.extraSet ?? {}).map(
    ([column, expr]) => sql`, ${sql.raw(column)} = ${expr}`
  );

  const rows = await ctx.db.execute(sql`
    update ${sql.raw(input.table)}
    set ${sql.raw(input.deltaColumn)} = ${sql.raw(input.deltaColumn)} + ${input.deltaMinor}${sql.join(
    extraAssignments,
    sql``
  )}
    where structure_id = ${ctx.actor.structureId}
      and ${sql.raw(idCol)} = ${input.id}
      and ${sql.raw(input.deltaColumn)} + ${input.deltaMinor} between 0 and ${sql.raw(input.ceilingColumn)}
    returning *
  `);
  return (rows as unknown as Row[])[0] ?? null;
}
