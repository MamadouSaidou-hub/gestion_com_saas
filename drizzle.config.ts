import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations are generated/applied with the MIGRATOR role (schema owner),
// never with the runtime DATABASE_URL (app_user), which has no DDL rights.
// See db/README.md for the two-role split rationale.
const connectionString =
  process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL_MIGRATOR (or DATABASE_URL) must be set to run drizzle-kit."
  );
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
  strict: true,
  verbose: true,
});
