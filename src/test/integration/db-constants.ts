// Shared constants between vitest.integration.config.ts (which injects
// these as process.env before any test file is imported, via `test.env`)
// and global-setup.ts (which spins up the actual container using the SAME
// values). Hardcoded rather than generated at runtime so both sides agree
// without needing env propagation from globalSetup into worker processes
// (not guaranteed by vitest across all pool types).

export const CONTAINER_NAME = "gcsaas-confirmsale-test-pg";
export const HOST_PORT = 55433;
export const DB_NAME = "gcsaas_test";
export const MIGRATOR_PASSWORD = "testmigratorpw";
export const APP_PASSWORD = "testapppw";

export const MIGRATOR_URL = `postgres://postgres:${MIGRATOR_PASSWORD}@127.0.0.1:${HOST_PORT}/${DB_NAME}`;
export const APP_URL = `postgres://app_user:${APP_PASSWORD}@127.0.0.1:${HOST_PORT}/${DB_NAME}`;
