import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index";

// ---------------------------------------------------------------------------
// Runtime DB client — uses the APP role (DATABASE_URL), never the migrator.
// `app_user` owns no tables and cannot bypass RLS. The app layer (Next.js,
// built separately) is responsible for:
//   1. Setting `app.structure_id` and `app.user_id` session GUCs per request
//      via `select set_config('app.structure_id', $1, false)` etc., scoped to
//      the request's authenticated tenant membership.
//   2. RESETTING those GUCs (`RESET app.structure_id` / set_config(..., '',
//      false)) at connection-pool checkin, so a pooled connection never
//      leaks a previous request's tenant context into the next one. This is
//      NOT implemented here — it is the responsibility of whoever builds the
//      pooling layer on top of this client. See db/README.md.
// ---------------------------------------------------------------------------

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set (app_user, not the migrator).");
}

const client = postgres(connectionString, {
  // Example pool-checkin hook — the app layer MUST implement the GUC reset
  // described above. `onclose`/custom pool wrappers differ by driver; this
  // is left as a placeholder comment, not a working implementation.
  // onclose: async (conn) => { await conn.query("RESET app.structure_id; RESET app.user_id;"); },
});

export const db = drizzle(client, { schema });
export { client as pgClient };
