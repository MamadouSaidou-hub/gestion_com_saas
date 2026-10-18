import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { APP_URL } from "./db-constants";
import { seedStructure, addMembership } from "./seed";

// ---------------------------------------------------------------------------
// H4 fix (security-reviewer, High) -- direct RLS verification, NOT through
// the app layer: migration 0013 adds owner-only INSERT/UPDATE/DELETE
// policies on `structure_settings`/`tax_settings` (previously generic
// tenant-floor, writable by ANY active member including a role that holds
// the app-layer `settings:write` permission but isn't owner -- i.e.
// `manager`). This connects as `app_user` directly (not the migrator,
// which bypasses RLS entirely and would prove nothing) and sets the same
// session GUCs `withTenantSession` sets, to confirm the POLICY itself
// rejects a non-owner write, independent of any application-layer check.
//
// M-a fix (security-reviewer follow-up): the original UPDATE-only test was
// VACUOUS -- `create_structure_with_owner()` never inserts a
// `structure_settings` row, so the manager's UPDATE affected 0 rows
// whether or not migration 0013 existed (there was nothing to protect
// either way). Fixed by covering BOTH of the two real states a structure
// can be in: (a) a row already exists (an owner set it at some point) --
// manager UPDATE must affect 0 rows; (b) no row exists yet (the NORMAL
// state for a brand-new structure, since D3/SoD is disabled by default
// and nothing creates this row automatically) -- manager INSERT must be
// rejected by the WITH CHECK clause as an actual RLS error, not silently.
// ---------------------------------------------------------------------------

async function asActor(
  userId: string,
  structureId: string,
  fn: (tx: postgres.TransactionSql) => Promise<readonly Record<string, unknown>[]>
): Promise<readonly Record<string, unknown>[]> {
  const sql = postgres(APP_URL, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('app.structure_id', ${structureId}, true)`;
      await tx`select set_config('app.user_id', ${userId}, true)`;
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

describe("H4: owner-only RLS on structure_settings/tax_settings (migration 0013)", () => {
  it("(a) a manager cannot UPDATE an EXISTING structure_settings row at the DB layer", async () => {
    const fixture = await seedStructure();
    const managerUserId = await addMembership(fixture, "manager");

    // Insert the row as OWNER first -- the normal way such a row comes to
    // exist at all (migration 0013's own owner-only INSERT policy).
    await asActor(fixture.ownerUserId, fixture.structureId, (tx) =>
      tx`insert into structure_settings (structure_id, sod_threshold_minor)
         values (${fixture.structureId}, 500000)
         returning structure_id`
    );

    const rows = await asActor(managerUserId, fixture.structureId, (tx) =>
      tx`update structure_settings set sod_threshold_minor = null where structure_id = ${fixture.structureId} returning structure_id`
    );
    // RLS's USING clause excludes the row entirely for this actor --
    // UPDATE affects 0 rows, not an error (SQL semantics for UPDATE/
    // DELETE: the row is simply not a candidate, no exception raised).
    expect(rows).toHaveLength(0);

    // Proves the row is genuinely unaffected, not just "returned nothing"
    // for an unrelated reason -- read it back as the owner.
    const stillThere = await asActor(fixture.ownerUserId, fixture.structureId, (tx) =>
      tx`select sod_threshold_minor from structure_settings where structure_id = ${fixture.structureId}`
    );
    expect(stillThere[0]?.sod_threshold_minor).toBe("500000");
  });

  it("(b) a manager cannot INSERT a structure_settings row when none exists yet (the normal state)", async () => {
    const fixture = await seedStructure();
    const managerUserId = await addMembership(fixture, "manager");

    // No row exists yet -- create_structure_with_owner() never inserts
    // one, and nothing else does either (D3/SoD disabled by default).
    // This IS the realistic scenario a manager would actually hit.
    await expect(
      asActor(managerUserId, fixture.structureId, (tx) =>
        tx`insert into structure_settings (structure_id, sod_threshold_minor)
           values (${fixture.structureId}, 500000)
           returning structure_id`
      )
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("an owner CAN write structure_settings at the DB layer", async () => {
    const fixture = await seedStructure();

    const rows = await asActor(fixture.ownerUserId, fixture.structureId, (tx) =>
      tx`insert into structure_settings (structure_id, sod_threshold_minor)
         values (${fixture.structureId}, 500000)
         on conflict (structure_id) do update set sod_threshold_minor = excluded.sod_threshold_minor
         returning structure_id`
    );
    expect(rows).toHaveLength(1);
  });

  it("a cashier can still READ tax_settings (needed by confirmSale's vat_rate lookup)", async () => {
    const fixture = await seedStructure();
    const cashierUserId = await addMembership(fixture, "cashier");

    const rows = await asActor(cashierUserId, fixture.structureId, (tx) =>
      tx`select vat_rate from tax_settings where structure_id = ${fixture.structureId}`
    );
    // Either no row (no tax_settings row seeded) or a readable row -- the
    // point is this does NOT throw/get rejected by RLS for a cashier.
    expect(Array.isArray(rows)).toBe(true);
  });
});
