import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import postgres from "postgres";
import { CONTAINER_NAME, HOST_PORT, DB_NAME, MIGRATOR_PASSWORD, APP_PASSWORD, MIGRATOR_URL } from "./db-constants";

// ---------------------------------------------------------------------------
// vitest `globalSetup` for the confirmSale integration suite: spins up a
// disposable postgres:16-alpine container, runs the project's OWN migration
// runners against it (business 0000->0010 + identity) as subprocesses, sets
// app_user's password (out-of-band, per db/README.md -- never committed),
// and tears the container down after the whole run.
//
// Windows note: node's child_process always shells out via COMSPEC
// (cmd.exe) by default, which cannot resolve `docker`/`npx` from this
// project's PATH as inherited from a Git-Bash/MSYS parent process
// (POSIX-style, colon-separated) -- confirmed by execution ("'docker' is
// not recognized..."), and forcing the shell to Git Bash's own bash.exe
// did NOT fix it either (that non-interactive bash gets its OWN minimal
// PATH, not this process's inherited one -- also confirmed by execution).
// The robust fix used here: avoid PATH lookup entirely -- Docker Desktop's
// well-known absolute install path for `docker`, and this project's own
// `node_modules/.bin/tsx.cmd` (a relative path cmd.exe resolves against
// cwd, no PATH search needed) for the migration runners.
// ---------------------------------------------------------------------------

const DOCKER_CANDIDATES = ["C:/Program Files/Docker/Docker/resources/bin/docker.exe", "docker"];
const DOCKER_BIN = DOCKER_CANDIDATES.find((candidate) => candidate === "docker" || existsSync(candidate)) ?? "docker";
// `node_modules/.bin/tsx.cmd` itself falls back to a bare `node` lookup on
// PATH when it finds no bundled `node.exe` next to it (it never ships
// one) -- in some Windows setups cmd.exe's own PATH (distinct from this
// Node process's PATH as inherited from a POSIX/Git-Bash parent) simply
// doesn't list node's install directory, so that bare `node` fails to
// resolve even though `process.execPath` (this very process) is a
// perfectly good node binary. Same "avoid PATH lookup entirely" fix as
// DOCKER_BIN above: invoke tsx's own CLI entry point directly via this
// process's absolute executable path instead of going through tsx.cmd.
const TSX_BIN = existsSync("node_modules/tsx/dist/cli.mjs")
  ? `"${process.execPath}" node_modules/tsx/dist/cli.mjs`
  : existsSync("node_modules/.bin/tsx.cmd")
    ? ".\\node_modules\\.bin\\tsx.cmd"
    : "npx tsx";

function quoteIfNeeded(bin: string): string {
  return bin.includes(" ") ? `"${bin}"` : bin;
}

function run(command: string, env: NodeJS.ProcessEnv = process.env): void {
  execSync(command, { stdio: "inherit", env });
}

function runQuiet(command: string): void {
  execSync(command, { stdio: "pipe" });
}

async function waitForPostgres(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const sql = postgres(url, { max: 1 });
    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (err) {
      lastError = err;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Postgres at ${url} did not become ready in time: ${String(lastError)}`);
}

export default async function globalSetup() {
  const docker = quoteIfNeeded(DOCKER_BIN);

  try {
    runQuiet(`${docker} rm -f ${CONTAINER_NAME}`);
  } catch {
    // No pre-existing container -- fine.
  }

  run(
    `${docker} run -d --name ${CONTAINER_NAME} ` +
      `-e POSTGRES_PASSWORD=${MIGRATOR_PASSWORD} -e POSTGRES_DB=${DB_NAME} ` +
      `-p ${HOST_PORT}:5432 postgres:16-alpine`
  );

  await waitForPostgres(MIGRATOR_URL);

  const migrationEnv = { ...process.env, DATABASE_URL_MIGRATOR: MIGRATOR_URL };
  run(`${TSX_BIN} src/db/migrate.ts`, migrationEnv);
  run(`${TSX_BIN} src/modules/identity/migrate.ts`, migrationEnv);

  // app_user is created by migration 0001 with NO password (set
  // out-of-band per db/README.md). Set one now for this disposable
  // container only -- never committed anywhere.
  const migratorSql = postgres(MIGRATOR_URL, { max: 1 });
  await migratorSql.unsafe(`alter role app_user with password '${APP_PASSWORD}'`);
  await migratorSql.end();

  return async function teardown() {
    try {
      runQuiet(`${docker} rm -f ${CONTAINER_NAME}`);
    } catch {
      // Best-effort cleanup.
    }
  };
}
