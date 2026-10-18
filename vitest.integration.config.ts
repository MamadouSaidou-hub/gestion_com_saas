import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { MIGRATOR_URL, APP_URL } from "./src/test/integration/db-constants";

// ---------------------------------------------------------------------------
// Separate config for the confirmSale integration suite (vitest AGAINST a
// disposable Postgres container, per the coordinator's explicit instruction
// for this turn). Deliberately NOT merged into the default `vitest.config.ts`
// / `npx vitest run` -- that one stays fast and Docker-free (its own header
// comment's convention), so `npm test` in CI doesn't suddenly require
// Docker. Run this suite with `npm run test:integration`.
//
// `test.env` is injected into `process.env` before any test file's static
// imports run (unlike `globalSetup`, which may run in a separate context
// not guaranteed to propagate env vars into worker processes) -- this is
// what lets `@/db/index.ts` (which reads `DATABASE_URL` at module load
// time) see the disposable container's connection string.
// ---------------------------------------------------------------------------

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./src/test/integration/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests exercise real FOR UPDATE locking/concurrency --
    // must run in a single process/worker so they don't race each other
    // for the document_counters row across unrelated test files.
    fileParallelism: false,
    env: {
      DATABASE_URL_MIGRATOR: MIGRATOR_URL,
      DATABASE_URL: APP_URL,
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
