import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Minimal unit-test config: pure, DB-free logic only (e.g. the audit PII
// guard, permission matrix). Updated (Phase 1 step 3): confirmSale's own
// suite DOES need a real Postgres container, per the architect's explicit
// instruction for that step -- rather than slow down this default config,
// it lives in a SEPARATE `*.integration.test.ts` suite with its own
// `vitest.integration.config.ts` + `npm run test:integration`, explicitly
// excluded here so `npx vitest run` / `npm test` stays fast and
// Docker-free.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
