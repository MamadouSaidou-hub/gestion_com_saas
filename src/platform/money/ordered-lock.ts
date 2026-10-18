import { sql } from "drizzle-orm";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// Shared row-locking primitive for the "read current state, decide, write"
// pattern that is NOT a plain atomic delta (inventory's
// lockLevelsForUpdate[AcrossWarehouses] already owns the multi-row ordered
// variant for stock_levels; this is the single-row equivalent for a config/
// counter-shaped row, e.g. a rebate scale's cycle state, which must be
// locked FOR UPDATE for the whole "count units since cycle start, maybe
// grant a tier, maybe advance the cycle" decision to be atomic against a
// concurrent delivery crossing the same threshold).
//
// `SELECT ... FOR UPDATE` inside the caller's own transaction -- this opens
// NO transaction of its own, same convention as every other ctx-based
// primitive in this codebase.
// ---------------------------------------------------------------------------

export async function lockRowForUpdate<Row extends object>(
  ctx: TenantSessionContext,
  table: string,
  id: string,
  idColumn = "id"
): Promise<Row | null> {
  const rows = await ctx.db.execute(sql`
    select *
    from ${sql.raw(table)}
    where structure_id = ${ctx.actor.structureId}
      and ${sql.raw(idColumn)} = ${id}
    for update
  `);
  return (rows as unknown as Row[])[0] ?? null;
}
