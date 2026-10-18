import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Migration runner — MUST use the migrator role (schema owner), not app_user.
// Run with: `npm run db:migrate` (requires DATABASE_URL_MIGRATOR set).
//
// Safety net (see db/README.md's "Rollback keeps drizzle's own journal
// honest" section): drizzle-orm's migrate() trusts ONLY its own bookkeeping
// table (drizzle.__drizzle_migrations), specifically only the single
// latest-by-created_at row in it — it never re-checks the live schema. If
// that table claims migrations are applied while the actual tables they
// created are missing (e.g. a down script rolled back the schema without
// also clearing the matching journal row, a manual DROP, a bad restore),
// migrate() silently no-ops and this script would otherwise print
// "Migrations complete." / exit 0 against an empty or partially-empty
// database. Reproduced by actual execution against a disposable container.
//
// This is a backstop, not the fix — the real fix is that every down script
// now deletes its own journal row (src/db/migrations/down/*.down.sql), so a
// rollback done through the documented procedure never reaches this state.
// This check exists for every OTHER way the journal and the live schema can
// drift apart (hand edits, partial restores, manual DDL) — it must never be
// treated as a substitute for keeping the down scripts' journal cleanup
// correct.
const CANARY_TABLES = [
  // One per schema area (tenancy.ts, catalog.ts, inventory.ts, sales.ts,
  // billing.ts, audit.ts) — enough to catch "the business schema silently
  // failed to come back", not an exhaustive check (see
  // scripts/ci/verify-business-schema.sql for the exhaustive one run in CI).
  "structures",
  "memberships",
  "products",
  "stock_movements",
  "sales",
  "invoices",
  "audit_log",
];

async function assertBusinessSchemaMatchesJournal(
  sql: postgres.Sql,
): Promise<void> {
  const journalRows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from drizzle.__drizzle_migrations
  `;
  const appliedCount = Number(journalRows[0]?.count ?? 0);
  if (appliedCount === 0) {
    // Nothing has ever been applied to this journal — a genuinely empty
    // database is expected to have no business tables either. Nothing to
    // cross-check.
    return;
  }

  const existingRows = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name = any(${CANARY_TABLES})
  `;
  const existing = new Set(existingRows.map((r) => r.table_name));
  const missing = CANARY_TABLES.filter((t) => !existing.has(t));

  if (missing.length > 0) {
    throw new Error(
      `Migration journal (drizzle.__drizzle_migrations) reports ${appliedCount} ` +
        `migration(s) applied, but expected business table(s) are missing from ` +
        `the "public" schema: ${missing.join(", ")}. The journal and the live ` +
        `schema have drifted apart (a down script that didn't clear its journal ` +
        `row, a manual DROP, a partial restore). Refusing to report success. Do ` +
        `NOT just re-run migrate:all expecting it to fix this — drizzle trusts ` +
        `the journal, so it will no-op again. Inspect drizzle.__drizzle_migrations ` +
        `by hand, reconcile it against the actual schema (or, on a throwaway/CI ` +
        `database only, \`drop schema if exists drizzle cascade;\` and re-migrate ` +
        `from scratch), then re-run.`,
    );
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL_MIGRATOR;
  if (!connectionString) {
    throw new Error("DATABASE_URL_MIGRATOR must be set to run migrations.");
  }

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  console.log("Running migrations (as migrator role)...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await assertBusinessSchemaMatchesJournal(client);
  console.log("Migrations complete.");

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
