import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Migration runner for Better Auth's own tables (user/session/account/
// verification). Deliberately NOT drizzle-kit's migrate() runner: these SQL
// files are hand-written (idempotent, IF NOT EXISTS-guarded) rather than
// drizzle-kit-generated, so there is no snapshot/journal to diff against.
// This runner just applies every *.sql file in this folder, in filename
// order, exactly once each, tracked in a tiny bookkeeping table -- kept
// deliberately separate from the business schema's migration journal (see
// schema.ts header comment for why the two pipelines must stay independent).
//
// MUST run with the MIGRATOR role (DATABASE_URL_MIGRATOR), never app_user.
// Run with: `npm run identity:db:migrate`.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const connectionString = process.env.DATABASE_URL_MIGRATOR;
  if (!connectionString) {
    throw new Error("DATABASE_URL_MIGRATOR must be set to run identity migrations.");
  }

  const sql = postgres(connectionString, { max: 1 });

  try {
    await sql`
      create table if not exists _identity_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    const dir = join(__dirname, "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const already = await sql`
        select 1 from _identity_migrations where filename = ${file}
      `;
      if (already.length > 0) {
        console.log(`identity migration ${file}: already applied, skipping.`);
        continue;
      }

      console.log(`identity migration ${file}: applying...`);
      const contents = readFileSync(join(dir, file), "utf8");
      await sql.unsafe(contents);
      await sql`
        insert into _identity_migrations (filename) values (${file})
      `;
      console.log(`identity migration ${file}: done.`);
    }

    // Safety net — same class of bug as src/db/migrate.ts's
    // assertBusinessSchemaMatchesJournal (see db/README.md's "Rollback
    // keeps drizzle's own journal honest" section). This runner trusts
    // _identity_migrations the same way drizzle trusts
    // drizzle.__drizzle_migrations: a row present here is taken as proof
    // the corresponding table exists, with no re-check against the live
    // schema. There is no down/ folder for this pipeline today (see
    // db/README.md's Layout section — a pre-existing, documented
    // asymmetry, not introduced or fixed here), so there is no hand-written
    // rollback script that could currently cause this drift. But the risk
    // is the same IF one is ever added without also deleting its row from
    // _identity_migrations, or if these tables are ever dropped by hand
    // (e.g. mid-development, or a bad restore) without touching this table.
    // Fail loudly instead of silently reporting "complete" against missing
    // tables.
    const identityTables = ["user", "session", "account", "verification"];
    const appliedCount = await sql<{ count: string }[]>`
      select count(*)::text as count from _identity_migrations
    `;
    if (Number(appliedCount[0]?.count ?? 0) > 0) {
      const existingRows = await sql<{ table_name: string }[]>`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = any(${identityTables})
      `;
      const existing = new Set(existingRows.map((r) => r.table_name));
      const missing = identityTables.filter((t) => !existing.has(t));
      if (missing.length > 0) {
        throw new Error(
          `_identity_migrations reports migration(s) applied, but expected ` +
            `identity table(s) are missing from the "public" schema: ` +
            `${missing.join(", ")}. The bookkeeping table and the live schema ` +
            `have drifted apart. Refusing to report success — re-running this ` +
            `script will not fix it, since every migration file is already ` +
            `marked applied. Inspect _identity_migrations by hand and reconcile ` +
            `it against the actual schema before re-running.`,
        );
      }
    }

    console.log("Identity migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
