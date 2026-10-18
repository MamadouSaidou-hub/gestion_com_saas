import { sql } from "drizzle-orm";
import { db } from "@/db/index";
import type { Actor } from "@/modules/tenancy/types";
import { createAuditWriter, type AuditWriter } from "@/platform/audit/audit-writer";

// ---------------------------------------------------------------------------
// withTenantSession -- the ONLY way application code may touch tenant-scoped
// tables. No other code path may grab a raw/pooled connection and query a
// tenant table directly: everything else (RLS policies, the audit chain)
// assumes `app.structure_id` / `app.user_id` were set, in-transaction, by
// this function, from an already-verified `Actor` (see
// modules/tenancy/resolve-actor.ts) -- never from unchecked client input.
//
// Implementation note: we use drizzle's own `db.transaction()` (which wraps
// postgres.js's `client.begin()` internally) rather than manually opening a
// postgres.js transaction and re-wrapping it with a fresh `drizzle(tx, ...)`
// call -- the latter looked plausible but fails at runtime: drizzle-orm's
// postgres-js driver constructor reads `client.options.parsers` to install
// its custom type parsers, and a bare `TransactionSql` proxy from
// `client.begin()` doesn't carry that `.options` object the way the
// top-level client does (confirmed by an actual crash against a live
// container: "Cannot read properties of undefined (reading 'parsers')").
// `db.transaction()` avoids this because it reuses the parent session's
// already-initialized dialect/parsers instead of constructing a new one.
//
// --- Why a single Postgres transaction is enough, no extra pool-reset code ---
//
// `set_config(name, value, true)` with is_local = true is the SQL equivalent
// of `SET LOCAL`: Postgres itself discards the setting at the end of the
// current transaction, on COMMIT *or* ROLLBACK, unconditionally. This is a
// guarantee from Postgres's own transaction machinery, not something that
// depends on pool behaviour: even if the process crashes mid-transaction, the
// guarantee below still holds because a dropped connection simply never
// reaches COMMIT, and the next client to grab that physical connection from
// Supabase's pooler will have the GUC reset by Postgres before it can ever
// run a statement in a NEW transaction (the old one never committed, so no
// half-set GUC can leak into a later, unrelated query on reuse).
//
// The property this file depends on, restated precisely: **every single
// statement that reads `app.structure_id`/`app.user_id` (i.e. every RLS
// policy evaluation on a tenant table) happens inside the exact transaction
// where this function set those GUCs.** We never call set_config with
// is_local = false (a session-persistent GUC) anywhere in this codebase, and
// we never hand out the raw pooled client (`db`/`pgClient` from
// src/db/index.ts) to business code for tenant-table queries -- only this
// function's own `tx`, scoped to one transaction, ever gets used that way.
// Given that discipline, a connection can never carry a tenant context
// between two unrelated transactions, with or without an explicit reset at
// pool checkin.
//
// Defense in depth anyway: we explicitly RESET both GUCs to '' at the START
// of every transaction, before setting them for the current actor. This
// costs nothing and guards against a future bug where some other code path
// (a mistake, not by design) sets a session-persistent GUC on a pooled
// connection -- if that ever happened, this explicit reset-then-set, rather
// than relying solely on transaction-end cleanup, ensures THIS transaction's
// view is still correct regardless of what a previous, buggy caller left
// behind on the connection. It does not replace the invariant above; it is a
// second, independent safety net for it.
// ---------------------------------------------------------------------------

// The transaction-scoped drizzle client type, derived directly from
// `db.transaction()`'s own callback parameter -- not hand-rolled -- so it
// can never drift out of sync with whatever drizzle-orm actually hands us.
export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface TenantSessionContext {
  db: TenantTx;
  audit: AuditWriter;
  actor: Actor;
}

export async function withTenantSession<T>(
  actor: Actor,
  fn: (ctx: TenantSessionContext) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    // Defense in depth -- see rationale above. Not required for correctness
    // given the is_local-only discipline, but cheap and worth keeping.
    await tx.execute(sql`select set_config('app.structure_id', '', true)`);
    await tx.execute(sql`select set_config('app.user_id', '', true)`);

    await tx.execute(
      sql`select set_config('app.structure_id', ${actor.structureId}, true)`
    );
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);

    const audit = createAuditWriter(tx, actor);

    return fn({ db: tx, audit, actor });
  });
}
