# Database layer — Drizzle + Supabase (PostgreSQL)

This directory's companion code lives under `src/db/`. This README explains
how to run migrations, the two-role split, and a hard requirement for
whoever builds the connection-pool / app layer on top of this schema.

## Layout

```
src/db/
  schema/
    tenancy.ts     structures, memberships, invitations, currencies
    catalog.ts      products, product_categories, units, warehouses,
                     suppliers, customers
    inventory.ts    stock_movements (ledger, source of truth),
                     stock_levels (derived projection)
    sales.ts        sales, sale_lines
    billing.ts       tax_settings, document_counters, invoices, payments,
                     payment_allocations
    stock-transfers.ts  stock_transfers/stock_transfer_lines,
                     stock_counts/stock_count_lines (added by migration 0014;
                     missing from this list until now -- stale doc, not a
                     schema gap, fixed while touching this file for 0015/0016)
    purchasing.ts    supplier_deliveries/supplier_delivery_lines,
                     supplier_payments/supplier_payment_allocations (0015)
    rebates.ts       rebate_scales/rebate_tiers/rebate_grants (0016)
    audit.ts        audit_log (append-only, hash-chained per tenant)
    index.ts        barrel export, used as drizzle-kit's `schema` entry
  migrations/
    0000_initial_schema.sql        drizzle-kit generated (tables, enums, FKs, indexes)
    0001_tenancy_rls_audit.sql     hand-written: roles, RLS, audit triggers/functions, grants
    0002_my_memberships.sql        hand-written: my_memberships() SECURITY DEFINER helper
    0003_tighten_rls_audit_security.sql  hand-written: C1/C2/H1/H2/H3/M1/M9 fixes
    0004_owner_lockdown_bypassrls_assert.sql  hand-written: H-A/H-C fixes, default-priv +
                                     pgcrypto hardening (see "Judgment calls" below)
    0005_structures_crosstenant_grant_regrant_fix.sql  hand-written: H-D/H-E/M-A fixes
                                     (fix-round #3, see "Judgment calls / deviations"
                                     entries 2c/2g/2h below)
    0006_memberships_invitations_owner_insert_guard.sql  hand-written: H-F fix +
                                     invited_by forgery fix (fix-round #4, see
                                     "Judgment calls / deviations" entry 2i below)
    0007_invitations_update_select_guard.sql  hand-written: H-H fix (invitations_update
                                     owner-escalation guard + immutability trigger) +
                                     invitations_select PII-leak fix (fix-round #5, see
                                     "Judgment calls / deviations" entry 2n below)
    0008_invitations_delete_guard_status_machine.sql  hand-written: H-I fix
                                     (invitations_delete owner-escalation guard) +
                                     M-B fix (status state machine + expires_at
                                     immutability in invitations_immutable_fields_guard())
                                     (fix-round #6)
    0009_business_layer_sales_billing.sql  hand-written: schema for the business
                                     application layer (credit sales, tickets-then-
                                     invoices, stock-shortage override, SoD config) --
                                     hardens stock_movements' polymorphic source
                                     reference (composite-FK sale_id), adds
                                     idempotency keys to sales/payments, ticket
                                     numbering via document_counters, invoices.
                                     paid_minor, new structure_settings table,
                                     dashboard indexes (see entry 2p below)
    0010_sales_payment_linkage.sql  hand-written: gap found implementing
                                     confirmSale (Phase 1 step 3) -- adds
                                     payments.sale_id (composite-FK, mirrors
                                     stock_movements.sale_id) and
                                     sales.paid_minor (mirrors
                                     invoices.paid_minor), see entry 2s below
    0011_invoice_sale_idempotent_issue.sql  hand-written: gap found
                                     implementing issueInvoiceForSale (Phase
                                     1 step 4) -- partial unique index on
                                     invoices(structure_id, sale_id) so
                                     "ask twice for the same sale" is a
                                     race-free ON CONFLICT, not a
                                     check-then-insert race, see entry 2t
    0013_owner_only_settings_rls.sql  hand-written: H4 fix (owner-only RLS
                                     on structure_settings/tax_settings
                                     writes), see entry 2u.
    0014_multi_store_transfers_counts.sql  hand-written: multi-store is now
                                     ACTIVE -- `warehouses` gains
                                     code/kind/is_active/address/phone
                                     (store vs depot), `memberships` gains a
                                     one-store-per-member `warehouse_id`
                                     ("gerant" = `manager` + warehouse_id,
                                     not a new role), the new SECURITY
                                     DEFINER `app_scoped_warehouse_id()`
                                     derives store scope from that SAME row
                                     (no new GUC), the store-scope RLS
                                     predicate is added to stock_movements/
                                     stock_levels/sales/payments/
                                     stock_transfers/stock_counts, new
                                     `stock_transfers`/`stock_transfer_lines`
                                     + `stock_counts`/`stock_count_lines`
                                     tables are added, and `stock_movements`'
                                     polymorphic source reference is
                                     rewritten as a true exclusive-arc CHECK
                                     (closes debt 2r in full) -- see entry 2x.
    0015_supplier_purchasing.sql    hand-written: supplier-side purchasing --
                                     `supplier_deliveries` (store-scoped like
                                     other stock-bearing rows, activates
                                     `stock_movements.supplier_delivery_id`'s
                                     composite FK, 0014 added the column
                                     specifically for this), `supplier_
                                     delivery_lines`, `supplier_payments`
                                     (tenant-floor ONLY, no warehouse_id --
                                     supplier debt is consolidated at tenant
                                     level), `supplier_payment_allocations`.
                                     Deliberately NOT reusing payments/
                                     invoices (2r lesson). See entry 2y.
    0016_rebates_and_trgm_search.sql  hand-written: generic, quantity-driven,
                                     cliff-mode, informational-only rebates
                                     (`rebate_scales`/`rebate_tiers`/
                                     `rebate_grants` -- exactly-one-party CHECK,
                                     not a party_type polymorph, applying 2r
                                     preventively) + `customers` clients-screen
                                     columns + `pg_trgm`-backed global search
                                     (`extensions` schema, GIN indexes on
                                     products/customers/suppliers). See entry 2z.
    down/                           MANUAL rollback scripts (see "Reversibility" below)
  index.ts          runtime DB client (app_user)
  migrate.ts         migration runner (migrator role)
```

## Two-role split (D2)

| Role | Env var | Used by | Rights |
|---|---|---|---|
| migrator | `DATABASE_URL_MIGRATOR` | `npm run db:migrate`, CI/CD migration job | Owns the schema, full DDL. Never used by the running app. |
| `app_user` | `DATABASE_URL` | Next.js app (Route Handlers / Server Actions) | Owns nothing. SELECT/INSERT/UPDATE/DELETE on tenant tables, subject to RLS. **No** DDL. **No** direct write on `audit_log` (only `EXECUTE` on `audit_log_append(...)`). |

Set `app_user`'s password **out-of-band** (Supabase dashboard / a one-off
`ALTER ROLE app_user WITH PASSWORD '...'` you run by hand) — never commit a
real password in a migration file. `.env.example` only has placeholders.

### Running migrations

```bash
npm install
cp .env.example .env   # fill DATABASE_URL_MIGRATOR with real creds, never commit .env
npm run db:generate    # (only when you change src/db/schema/*.ts) — regenerates 0000
npm run db:migrate     # applies every migration in src/db/migrations, in order, as the migrator role
```

### Two separate migration pipelines — always run in this order

This repo has **two independent migration runners with no shared bookkeeping**:
`npm run db:migrate` (business, this folder, drizzle-kit journal) and
`npm run identity:db:migrate` (`src/modules/identity/migrations/`, its own
`_identity_migrations` table). Nothing enforces their relative order at
runtime, and running them out of order has caused a real privilege-regrant
bug (H-E, fix-round #3, see below). **Always run them together, in this
order**, via the combined script:

```bash
npm run migrate:all   # = npm run db:migrate && npm run identity:db:migrate
```

Use this in every environment (local, CI, deploy) instead of calling the two
scripts separately. `0005_structures_crosstenant_grant_regrant_fix.sql` adds
a terminal, order-independent safety net for the specific privileges this
ordering bug affects, but `migrate:all` is still the one documented correct
invocation — don't rely on the safety net as a substitute for running
migrations in the right order.

`npm run db:generate:custom` creates a new empty hand-written SQL migration
file in the same folder/journal when you need more RLS/trigger/grant work
that drizzle-kit can't express from the TS schema (follow the pattern in
`0001_tenancy_rls_audit.sql`).

### A new `.sql` file in this folder is NOT enough — `meta/_journal.json` is the real source

**Found while building/validating 0015/0016, confirmed by actual execution
against a disposable container.** `drizzle-orm`'s runtime migrator
(`readMigrationFiles` in `node_modules/drizzle-orm/migrator.js`, used by both
`src/db/migrate.ts` and any `db:migrate` invocation) does **not** scan
`src/db/migrations/*.sql` on disk. It reads **only**
`src/db/migrations/meta/_journal.json`, and for each `entries[]` row loads
`<tag>.sql` by exact filename. Dropping a new hand-written migration file into
the folder — even with the next sequential number, even referenced correctly
everywhere else (this README's Layout list, `scripts/ci/verify-business-
schema.sql`, the down/ script) — is **silently never applied**: `migrate()`
reports "Migrations complete." / exit 0 having done nothing, because as far
as it's concerned the journal still ends at the previous entry. Reproduced
exactly this way while validating `0015_supplier_purchasing.sql`/
`0016_rebates_and_trgm_search.sql`: both files existed on disk, both were
syntactically valid (confirmed by applying them directly with `psql -f`), yet
`npm run db:migrate` against a freshly wiped database stopped at 0014 with no
error until `meta/_journal.json` gained matching `{ idx, tag, when,
breakpoints: true }` entries for them.

**The rule:** every new migration file (generated via `db:generate` /
`db:generate:custom`, or added by hand as this project's convention
otherwise requires) MUST have a corresponding entry appended to
`src/db/migrations/meta/_journal.json`'s `entries` array, `tag` matching the
file's name without `.sql`, `idx` one past the previous entry, `when` any
later millisecond timestamp than the previous entry's. `db:generate`/
`db:generate:custom` do this automatically when they work; this note exists
for the case — already the norm in this project since 0002 — where a
migration is added by hand without going through either command. No
snapshot file (`meta/NNNN_snapshot.json`) is required for a hand-written
migration: those are only used by `drizzle-kit generate` for TS-schema
diffing, never read by the runtime `migrate()` path — confirmed by
inspecting `readMigrationFiles()` itself, and consistent with this project's
pre-existing state (no snapshot files exist for 0002 through 0016, all
hand-written, and migrations apply correctly regardless).

### Reversibility

drizzle-kit's migration runner is **forward-only** — it has no built-in
`down`. Every migration here still has a hand-written, tested rollback
script in `src/db/migrations/down/`, run manually with the migrator role if
you ever need to undo a migration (e.g. mid-development).

**The rule, not a hand-maintained list:** apply `down/*.down.sql` scripts in
**strict reverse filename order** (highest-numbered first) — each one's RLS
policies, triggers and functions reference objects created by an earlier
migration, and (since the fix below) each one also depends on the
immediately-later migration's row still being the latest one in drizzle's
journal. This repo used to enumerate every script by name here; that list
silently went stale (it stopped at 0011 while 0012–0014 already existed on
disk) the first time someone added a migration and forgot to also update
the README. Don't trust a hand-written list — derive it:

```bash
for f in $(ls -1 src/db/migrations/down/*.down.sql | sort -r); do
  psql "$DATABASE_URL_MIGRATOR" -v ON_ERROR_STOP=1 -f "$f"
done
```

This exact derivation (dynamic `sort -r`, not a hand list) is what CI's
`migration-cycle` job (`.github/workflows/ci.yml`) runs on every PR, against
a disposable `postgres:16-alpine` service container: full forward
`migrate:all`, full reverse down sweep, full forward `migrate:all` again,
then `scripts/ci/verify-business-schema.sql` asserts a canary set of tables
from every schema area actually exists. That job is the enforcement
mechanism for "the down scripts stay runnable in reverse filename order" —
this README states the rule and points at it instead of re-deriving the
list by hand again.

Every down script up to 0004 was tested end-to-end against a throwaway
`postgres:16-alpine` container during this scaffold's development (apply
0000 → ... → 000N → down 000N → ... → down 0000, clean exit, no orphaned
objects); 0005's down script was validated the same way during fix-round
#3, 0006's down script was validated the same way during fix-round #4,
0007's down script was validated the same way during fix-round #5, 0008's
down script was validated the same way during fix-round #6, and 0009's down
script was validated the same way when the business-layer schema was added
(down applied against the full 0000->0009 chain, then 0009 re-applied
cleanly on top — see 0009's own header comment for the full transcript).

### Rollback keeps drizzle's own journal honest

**Found by building CI's `migration-cycle` job, fixed here — read before
touching any down script.** A full down sweep (apply every `down/*.down.sql`
in reverse order, then run `npm run migrate:all` again) used to print
"Migrations complete." and exit 0 while the business schema stayed
completely empty. Verified by actual execution, twice, against a disposable
`postgres:16-alpine` container.

Root cause: `drizzle-orm`'s `migrate()` (`node_modules/drizzle-orm/pg-core/
dialect.js`) never looks at the live schema. It only reads its own
bookkeeping table, `drizzle.__drizzle_migrations`, and specifically only the
**single row with the highest `created_at`** in it (`order by created_at
desc limit 1`) — then re-applies every migration file whose journal
timestamp is newer than that row's. The hand-written `down/*.down.sql`
scripts dropped the tables, policies, functions and triggers each migration
created, but never touched that bookkeeping row. So after a full down
sweep, the journal still said "everything up to 0014 is applied," `migrate()`
believed it, applied nothing, and reported success against an empty
`public` schema.

A **partial** rollback (e.g. down `0014` and `0013` only, then re-migrate)
has exactly the same bug, not a lesser version of it: the journal still
claims `0014` is applied even though its tables/columns are gone, so
`migrate()` no-ops entirely instead of re-applying `0013` and `0014` — the
database is left in a state that doesn't match 0000–0012 *or* 0000–0014.

**The fix (mechanism (a), the actual cure):** every `down/*.down.sql` script
now ends by deleting its own row from `drizzle.__drizzle_migrations`. Since
`migrate()` only ever cares about the single latest row, and down scripts
are always run in strict reverse order (see above), the row for *this*
migration is guaranteed to be the current `max(id)` row at the moment its
down script runs — there is no need to compute or match drizzle's
`sha256(file content)` hash, which would be fragile to reproduce byte-for-
byte inside a hand-written SQL file. Each deletion is guarded by a `raise
exception` if the table is already empty (catches "down scripts run out of
order" or "this one already ran" instead of silently deleting nothing).
This makes both the full sweep and the partial-rollback case correct: after
down `0014` + down `0013`, the journal's latest row is `0012`'s, so the next
`migrate:all` re-applies exactly `0013` and `0014` — not the whole chain,
and not a no-op.

Dropping the whole `drizzle` schema from `down/0000_initial_schema.down.sql`
(the other option considered) was rejected as the primary fix: it only
cures the full-sweep case. A rollback that stops at `0012` never reaches
`down/0000`, so the partial-rollback hole above would still exist untouched.

**The safety net (mechanism (b)):** `src/db/migrate.ts` now also refuses to
report success if the journal claims migrations are applied but a canary
set of business tables (one per schema area) doesn't actually exist in
`public`. This is a backstop for every OTHER way the journal and the live
schema can drift apart — a hand DROP, a bad restore, a future down script
that forgets the cleanup above — not a substitute for the fix in those
scripts. `src/modules/identity/migrate.ts` got the equivalent check: its own
`_identity_migrations` bookkeeping table has the same class of flaw (it
records "applied" by filename and is never cross-checked against the live
schema either), even though no `down/` folder exists for it today to
actually trigger the drift (see Layout above).

Validated by execution against a disposable `postgres:16-alpine` container:
full chain `0000→0014` (business) + identity, full down sweep in reverse
order, `migrate:all` again — now correctly re-applies all 15 business
migrations and reports the same canary tables present, instead of silently
succeeding against an empty schema. Partial rollback (down `0014` + `0013`
only, then `migrate:all`) re-applies exactly those two and leaves
`0000`–`0012`'s objects untouched, confirmed by re-running the exploit/
regression suite from fix-rounds #1–#6 with zero regressions.

## RLS — the floor, not the ceiling

Every tenant-scoped table has `ENABLE ROW LEVEL SECURITY`; most also have
`FORCE ROW LEVEL SECURITY` — **except `structures` and `memberships`**, which
are `ENABLE`d but explicitly **not** `FORCE`d (see "Judgment call to flag to
`security-reviewer`" below for why: `0004` drops FORCE there on purpose to
stop the SECURITY DEFINER helpers from recursing into themselves and to let
`create_structure_with_owner()` perform its own INSERT). Every tenant-scoped
table's policies are built on two SECURITY DEFINER helpers:

- `app_current_structure_id()` / `app_current_user_id()` read the session
  GUCs `app.structure_id` / `app.user_id`, collapsing both "never set" and
  "reset to empty string" to `NULL` via `nullif(..., '')` — so the policy
  **default-denies** (no error, no all-rows) whenever the app hasn't set a
  tenant context, instead of throwing a cast error or (worse) matching
  everything.
- `is_member_of_current_structure(uuid)` / `has_role_in_current_structure(text[])`
  re-verify the GUC against a real, active `memberships` row — a forged or
  stale `app.structure_id` alone is not enough to read/write anything.

This is proven by a self-test embedded in `0001_tenancy_rls_audit.sql`
(fails the migration loudly if the default-deny property ever breaks) and
was additionally verified manually against a live container: a user scoped
to tenant A cannot read tenant B's rows, and an INSERT with a `structure_id`
that doesn't match the caller's GUC is rejected by Postgres with "new row
violates row-level security policy" rather than silently succeeding.

**RLS is the floor only.** The Next.js app (Route Handlers / Server Actions)
still re-checks per-operation role authorization (e.g. a `cashier` must not
be able to delete an `invoice`, only `owner`/`accountant` can) — the generic
tenant tables' RLS policies only enforce tenant membership, not per-role
write rules. Encode those in the app layer; do not rely on RLS alone for
anything beyond "this row belongs to a tenant I'm an active member of."

### Connection-pool GUC reset — resolved by the app layer, not pool config

**Update (post security-review):** this used to say pool-checkin GUC reset
was a hard requirement left to "whoever builds the app layer on top of this
schema" — that framing is no longer accurate and the claim was wrong to
leave open-ended. The app layer (`src/platform/db/withTenantSession.ts`,
`src/modules/tenancy/resolve-actor.ts`) is now built, and it does not depend
on pool-checkin behaviour at all: every tenant-scoped query sets
`app.structure_id`/`app.user_id` with `set_config(name, value, true)` —
`is_local = true`, the SQL equivalent of `SET LOCAL` — inside the SAME
Postgres transaction that reads them, and Postgres itself discards
`SET LOCAL` values unconditionally at `COMMIT` *or* `ROLLBACK`, independent
of pool/driver behaviour. See `withTenantSession.ts`'s header comment for the
full argument, restated briefly here: as long as every tenant-table query
goes through `withTenantSession()` (now enforced by an ESLint
`no-restricted-imports` rule on the raw `@/db/index` client — see M4 in the
security-reviewer report) and the app never calls `set_config` with
`is_local = false` (a session-persistent GUC), a pooled connection can never
carry tenant context from one transaction into an unrelated later one, with
or without an explicit reset at pool checkin.

The app layer still does an explicit reset-to-empty at the *start* of every
transaction anyway (belt-and-suspenders, not required by the argument
above), so there is nothing further required of whoever configures
pgBouncer/Supabase's pooler for this project.

### Judgment call to flag to `security-reviewer`

**Correction (post follow-up security-review, fixed in migration `0004`):**
this used to describe the BYPASSRLS dependency as "fails closed, not a
security leak" — that was wrong, confirmed by actual execution against a
disposable container without BYPASSRLS. `FORCE ROW LEVEL SECURITY` on
`structures`/`memberships` applied even to the SECURITY DEFINER helpers'
*own* role, which caused `is_member_of_current_structure()` to recurse into
itself (gated SELECT → same gated SELECT → infinite loop) instead of simply
under-returning, and separately made `structures_insert`'s `with check
(false)` block `create_structure_with_owner()`'s own INSERT outright. That
is a hard crash on every tenant query and a hard block on tenant creation
for any migrator lacking BYPASSRLS — not a graceful degradation.

`0004_owner_lockdown_bypassrls_assert.sql` fixes this at the root: it drops
`FORCE ROW LEVEL SECURITY` on `structures` and `memberships` specifically
(RLS stays `ENABLE`d — `app_user`, which owns no tables, is still fully
policy-gated; only the table OWNER stops being subject to its own policies,
which is what removing FORCE actually controls). It also adds a `DO $$ ...
RAISE EXCEPTION` assertion near the top of that migration that checks
`pg_roles.rolbypassrls` for `current_user` and fails the migration loudly,
naming the role, if it's false — because BYPASSRLS is *still* required for
every table that keeps FORCE (`audit_log`, `invitations`, and the full
`tenant_tables` loop from section 8 of `0001`), whose SECURITY DEFINER
readers (`audit_log_before_insert`, `audit_log_verify`) depend on it the
same way. On Supabase this holds automatically because the project's
`postgres`/owner role already has `BYPASSRLS`. If a dedicated non-superuser
migrator role is introduced instead, a superuser must grant it explicitly:
`ALTER ROLE <migrator_role> BYPASSRLS;` (the migration intentionally does
NOT attempt to self-grant this, since a non-superuser migrator would fail
the whole migration on that statement — the new assertion makes that
failure an explicit, named-role exception at migration time instead of a
mysterious runtime recursion later).

## Audit trail (D10)

`audit_log` is append-only and hash-chained **per tenant** (not one global
chain, to avoid cross-tenant lock contention and metadata leakage). Verified
end-to-end against a live container during development:

- `audit_log_append(...)` (SECURITY DEFINER) is the only way `app_user` can
  write a row — direct `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` are revoked
  from `app_user` at the grant level, on top of RLS, on top of a
  `BEFORE UPDATE OR DELETE` trigger that raises unconditionally (three
  independent layers).
- The `BEFORE INSERT` trigger computes `entry_hash = sha256(prev_hash ||
  structure_id || actor_id || action || target_type || target_id ||
  payload::text || created_at)` and a per-tenant `seq`, serialized per
  tenant with `pg_advisory_xact_lock(hashtextextended(structure_id::text, 0))`
  so concurrent writers for *different* tenants never block each other.
- `audit_log_verify(structure_id)` recomputes the chain for one tenant and
  returns the first broken entry's `id` (or `NULL` if intact). Manually
  confirmed: disabling the immutability trigger as a superuser (something
  `app_user` cannot do) and tampering with a row's payload makes
  `audit_log_verify` correctly return that row's id.
- Daily seal to a WORM/object-lock bucket (per CLAUDE.md non-negotiables) is
  **not built here** — it's a scheduled job (pg_cron / external scheduler)
  for the devops agent, using the query documented at the end of
  `0001_tenancy_rls_audit.sql`.

## Currency / monetary columns (D8)

One currency per tenant (`structures.currency_code`), but every monetary
table/line also carries its own `currency_code` (denormalized, not just
inherited), and every amount is `bigint` minor-unit — never `float`/`numeric`
for money. `currencies(code, exponent)` is a small seeded lookup (`XOF`,
`GNF`, both exponent 0). Extending to more currencies is just a seed insert.

## Stock valuation (D9)

`stock_movements` is the append-only ledger and the only source of truth
(product, warehouse, direction, quantity, unit cost, reason, source
reference, actor, timestamp). `stock_levels` is a **derived, recomputable**
projection (current quantity + average cost) — treat it as a cache, never
write business logic that trusts it over the ledger.
`structures.valuation_method` (`cump` | `fifo`) is ready for a future FIFO
projection; only the CUMP (weighted-average) projection is expected to be
implemented by the app layer for now.

## Composite FK pattern

Every intra-tenant foreign key is composite: `(structure_id, x_id)
references target(structure_id, id)`, so a row can never reference another
tenant's row at the database level, not just by app-layer discipline. This
requires each FK target to have a `UNIQUE (structure_id, id)` constraint in
addition to its own `id` primary key (Postgres needs an exact unique-
constraint match on the referenced columns) — see the `unique(...)` table
constraints in `catalog.ts`, `sales.ts`, `billing.ts`.

## Judgment calls / deviations for `security-reviewer`

1. **No DB-level FK from `memberships.user_id` to a `user` table.** Better
   Auth owns its own `user`/`session`/`account`/`verification` tables via
   its own adapter migrations, not managed here, to avoid two migration
   owners fighting over the same objects. `memberships.user_id` (and every
   other `*_by`/`actor_id` column that stores a Better Auth user id) is a
   bare `text` column with no SQL FK. Once Better Auth's `user` table exists
   in the same database, consider adding the FK in a follow-up migration —
   or deliberately keep it FK-less and enforce referential integrity at the
   app layer. Flag for explicit sign-off.
2. **BYPASSRLS dependency** for the membership/audit SECURITY DEFINER
   helpers — see above. Corrected in `0004`: the dependency was a hard
   crash (RLS-function recursion) and a hard block on tenant creation
   without BYPASSRLS, not a graceful under-return as originally documented.
   `0004` removes the dependency for `structures`/`memberships` (NO FORCE)
   and adds a migration-time assertion for the tables that still need it
   (`audit_log`, `invitations`, the tenant_tables loop).
2b. **Owner-row protection gap, closed in `0004`.** 0003's
   `memberships_update`/`memberships_delete` policies blocked acting on
   your own row and blocked promoting a row TO `owner` by a non-owner, but
   did not stop a `manager` from demoting or deleting an EXISTING `owner`'s
   row as long as another owner remained — the owner-lockout trigger only
   blocks removing the LAST active owner, not an individual one. `0004`
   adds `role <> 'owner' or has_role_in_current_structure(array['owner'])`
   to both policies' `USING` clause (checked against the row being
   updated/deleted, i.e. the OLD role), so a non-owner cannot touch any row
   that currently is `owner`, full stop.
2c. **PUBLIC-EXECUTE default-privilege gap — flagged in `0004`, actually
   fixed in `0005` (M-A, fix-round #3).** 0003's C2 fix revoked PUBLIC
   EXECUTE per existing function, but left PostgreSQL's PUBLIC-executable
   default in place for functions created afterwards. `0004` added
   `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS
   FROM PUBLIC;` (and an `IN SCHEMA extensions` equivalent) intending to
   close this — **correction: verified by actual execution that this
   specific statement is a silent no-op.** The `IN SCHEMA` form of
   `ALTER DEFAULT PRIVILEGES ... REVOKE` cannot subtract anything here (the
   implicit owner-only default isn't stored as a per-schema entry to revoke
   from); `pg_default_acl` ends up empty and a function created afterwards
   still has `proacl = NULL` (= PUBLIC execute), confirmed for both `public`
   and `extensions`. 0004's header comment claiming this was "VERIFIED BY
   ACTUAL EXECUTION" is wrong for this one statement — not edited in 0004's
   SQL body (this project's "never edit 0000-0004 in place" convention),
   corrected here instead. `0005_structures_crosstenant_grant_regrant_fix.sql`
   replaces it with the GLOBAL form (no `IN SCHEMA` clause):
   `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;` —
   verified by execution to actually write a `pg_default_acl` entry and be
   honored for functions created afterwards, in any schema the migrator
   creates them in.
2d. **`pgcrypto` relocated, in `0004`.** It was installed in `public` with
   EXECUTE implicitly granted to PUBLIC on `crypt`/`gen_salt`/`digest`/
   `hmac`/`pgp_*`, reopening exactly the PostgREST/Data-API surface C2
   closed. Moved to a dedicated `extensions` schema (Supabase convention),
   EXECUTE revoked from PUBLIC there too. `audit_log_before_insert()` /
   `audit_log_verify()` (the only two callers of `digest()`) had their
   `search_path` updated to `public, extensions` accordingly.
   **CORRECTION (fix-round #4, H-G)** — the non-superuser BYPASSRLS migrator
   path described below as a "supported alternative to Supabase" is
   **NOT SUPPORTED, do not use it.** This project's migrator role MUST be a
   Supabase-style owner role with effective superuser/BYPASSRLS privileges
   (true by default for the `postgres` role on a Supabase project).
   Self-hosting Postgres with a deliberately restricted, non-superuser
   migrator role is **out of scope and known broken**: this relocation step
   (0004 section 5, `alter extension pgcrypto set schema extensions`) only
   succeeds for a role that OWNS pgcrypto's member functions, which a
   non-superuser migrator does not, even with BYPASSRLS granted
   (BYPASSRLS bypasses row-level security, not object ownership — pgcrypto's
   C-language member functions are owned by the bootstrap superuser that ran
   `CREATE EXTENSION`, not by whoever's role happened to issue that
   statement). Depending on exactly how pgcrypto was installed on that
   environment, this either fails the migration outright (the
   `insufficient_privilege` branch in 0004 section 5), or — if someone
   worked around it by pre-creating pgcrypto directly in `extensions` by
   hand — the migration proceeds but silently leaves pgcrypto's ~36 member
   functions EXECUTE-able by PUBLIC in that schema, because the non-superuser
   migrator also cannot run the subsequent `revoke execute on all functions
   in schema extensions from public` with full effect against objects it
   doesn't own in every Postgres version/config tested. Both outcomes were
   reproduced by execution. Rather than engineer a non-superuser-safe path
   around object ownership (significant added complexity, and this project
   targets Supabase per CLAUDE.md's stack), the decision is to require a
   true superuser/BYPASSRLS migrator and document the restricted-role path
   as unsupported. **Enforcement:** the BYPASSRLS assertion already added in
   `0004` section 1 (`raise exception` if `current_user`'s `rolbypassrls` is
   false) is what catches a misconfigured non-Supabase migrator at migration
   time — this is the correct and sufficient guard given this decision; no
   further code change was made for H-G.
2g. **H-D, cross-tenant `structures` write — fixed in `0005` (fix-round
   #3).** `structures_select`/`structures_update` used
   `is_member_of_current_structure(id)` (membership check against the
   TARGET row) instead of `tenant_access(id)` (which also pins the row's
   id to the session GUC). A session scoped to structure S1, belonging to
   a user who is also a member of S2 under a different role, could
   SELECT/UPDATE S2's row — including `currency_code`/`valuation_method`/
   `country_code`. Reproduced by execution; fixed by switching both
   policies to `tenant_access(id)`. `my_memberships()` (0002) confirmed
   unaffected — it never depends on `app.structure_id` being set.
2h. **H-E, identity privilege regrant window — mitigated in `0005`
   (fix-round #3).** `app_user` could regain `DELETE` on
   `user`/`account` and `UPDATE` on `verification` if
   `identity:db:migrate` ran before `db:migrate` on an environment where
   `app_user` already existed (a cluster-wide role, so
   `0001_tighten_grants.sql`'s existence guard silently no-ops in that
   case). `0005` re-asserts the same REVOKEs as a terminal, order-
   independent step owned by the business pipeline. The durable fix is
   still operational: always run `npm run migrate:all` (added to
   `package.json`), never the two scripts separately in arbitrary order.
2i. **H-F, memberships/invitations owner-escalation INSERT gap — fixed in
   `0006` (fix-round #4).** `0004` (H-A) added an owner-protection guard to
   `memberships_update`/`memberships_delete`'s `USING` clause (a non-owner
   cannot touch a row that already IS `owner`), but `memberships_insert`
   and `invitations_insert` never got the equivalent guard on their
   `WITH CHECK` clause (the NEW row) — so a `manager` could INSERT a
   brand-new `owner` membership row directly, or create an `owner`-role
   invitation, fully bypassing the H-A protections via an unpatched INSERT
   path. Reproduced by execution. `0006` adds
   `role <> 'owner' or has_role_in_current_structure(array['owner'])` to
   both `WITH CHECK` clauses. A legitimate owner can still insert/invite a
   new co-owner; `create_structure_with_owner()`'s own bootstrap INSERT is
   unaffected (SECURITY DEFINER, NO FORCE RLS on `memberships`).
2j. **`invitations.invited_by` forgery — fixed in `0006` (fix-round #4).**
   Unlike `audit_log_append` (forced to the real session actor since C1/
   `0003`), `invitations.invited_by` was caller-supplied with no check it
   matched the session user — a manager could create an invitation
   attributed to the owner, forging attribution on a sensitive action.
   `0006` adds `and invited_by = app_current_user_id()` to
   `invitations_insert`'s `WITH CHECK`.
2k. **H-G, non-superuser BYPASSRLS migrator — decided NOT SUPPORTED, not
   fixed (fix-round #4).** See the corrected entry **2d** above: engineering
   a non-superuser-safe path around pgcrypto's object-ownership requirement
   was judged not worth the added complexity for a project that targets
   Supabase (CLAUDE.md's stack). This project's migrator role MUST be a
   Supabase-style owner role with superuser/BYPASSRLS privileges; the
   restricted-role alternative previously described as "supported" is not,
   and is caught at migration time by `0004`'s existing BYPASSRLS
   assertion.
2l. **Unlimited tenant creation — residual M9 debt, explicitly DEFERRED,
   not fixed in `0006`.** `create_structure_with_owner()` still has no
   quota. This is left as accepted debt rather than coded around: a
   per-account/per-plan tenant limit needs a plan/subscription/billing
   model that does not exist in this schema yet, so any limit added at the
   DB layer now (e.g. a hardcoded count) would be throwaway work, likely
   re-done once a real billing module exists. Revisit with `architect` +
   `db-supabase` once that module is designed; app-side gating in the
   billing module is the more natural home for this check than a DB
   constraint.
2n. **H-H, `invitations_update` owner-escalation gap — fixed in `0007`
   (fix-round #5).** `0006` closed the equivalent gap on `memberships_insert`/
   `invitations_insert` (H-F) and `0004` closed it on `memberships_update`/
   `memberships_delete` (H-A), but `invitations_update` was never touched —
   its pre-0007 policy (`tenant_access(structure_id) and
   has_role_in_current_structure(array['owner','manager'])`) checked nothing
   about the row's `role`, `invited_by`, `email` or `token_hash`. Reproduced
   by execution: a `manager` could INSERT a legitimate `cashier`-role
   invitation (passes 0006's INSERT guard), then
   `UPDATE invitations SET role = 'owner' WHERE id = ...` on that same row,
   handing ownership to whoever accepts it — fully bypassing 0004/0006 via
   the one write path those two migrations didn't cover. Also reproduced: a
   manager rewriting `invited_by` on any row to forge attribution, and a
   manager overwriting `email`/`token_hash` on an existing OWNER-role
   invitation created by the real owner to redirect it to an address/token
   the manager controls (hijacking, not just forging).

   Fixed in two independent layers in `0007`:
   1. `invitations_update`'s `USING` and `WITH CHECK` clauses gain the same
      `role <> 'owner' or has_role_in_current_structure(array['owner'])`
      guard already used elsewhere — a non-owner cannot target a row that
      currently IS owner-role, and cannot turn any row INTO owner-role.
   2. A new `BEFORE UPDATE` trigger (`invitations_immutable_fields_guard`)
      makes `invited_by`, `email`, `token_hash`, `role` and `structure_id`
      immutable via UPDATE, for every caller including owners. Any other
      change must go through revoke-and-recreate on the already-guarded
      INSERT path. This independently blocks the forgery/hijack scenarios
      even if the policy guard above is ever loosened again, and is why
      confirmed test (c-bis) shows even an OWNER cannot rewrite
      `email`/`token_hash` on their own invitation via UPDATE — by design,
      there is no legitimate business flow that retargets an existing
      invitation.

      **Correction (fix-round #6):** this originally said "only `status`
      may ever change through UPDATE" here. That was never fully accurate
      — `expires_at` was never actually frozen by this trigger, so a
      manager could resurrect an expired/revoked invitation by pushing its
      expiry forward, and `status` itself had no transition rules (a
      manager could flip a revoked invitation straight back to `pending`).
      Both are closed in `0008` (M-B, see entry 2o below); as of `0008` the
      accurate statement is: `status` may change via UPDATE only while its
      current value is `pending`, and nothing else (including `expires_at`)
      may ever change via UPDATE.

   **Deliberately NOT done:** pinning `invited_by = app_current_user_id()`
   into the UPDATE policy's `WITH CHECK`, unlike what 0006 did for INSERT.
   That would incorrectly block a legitimate OWNER from revoking
   (`status = 'revoked'`) an invitation a MANAGER created (`invited_by` is
   the manager's id, not the owner's) — an owner must be able to revoke any
   invitation in their structure regardless of who sent it. The immutability
   trigger is the correct mechanism for the forgery/hijack case; the UPDATE
   policy is only responsible for the role-escalation case.

   Same migration also fixes a **Medium**: `invitations_select`'s `USING`
   clause was just `tenant_access(structure_id)` — no role check — so any
   tenant member, including a `cashier`, could read every pending
   invitation's `email`, `role` and `token_hash` (PII leak + recon on
   in-progress escalations). Fixed by requiring
   `has_role_in_current_structure(array['owner','manager'])` in addition,
   matching the role gate already on INSERT/UPDATE/DELETE.

   Validated by execution against a disposable `postgres:16-alpine`
   container, full chain 0000→0007 (business) + identity 0000→0001,
   superuser (Supabase-style BYPASSRLS) migrator only: all of (a) manager
   role-escalation blocked, (b) manager `invited_by` forgery blocked by the
   trigger, (c) manager email/token_hash hijack blocked (both by the
   USING-clause owner guard on the owner-role target row, and by the
   trigger), (d) owner/manager `status = 'revoked'` still works, (e) owner
   setting `role = 'owner'` to its already-current value (no-op) still
   succeeds (not over-blocked), (f) cashier SELECT now returns 0 rows while
   owner/manager SELECT is unaffected. Full prior exploit suite (C1, C2, H2,
   H3, H-A, H-D, H-E, H-F, M-A, owner-lockout, M1) re-run with zero
   regression across all 7 migration rounds.
2o. **H-I, `invitations_delete` owner-escalation gap — fixed in `0008`
   (fix-round #6).** `0007` (H-H) closed the owner-escalation gap on
   `invitations_update`, but `invitations_delete` (unchanged since `0001`)
   never got the equivalent guard — its policy was just
   `tenant_access(structure_id) and
   has_role_in_current_structure(array['owner','manager'])`, with no check
   on the row's `role`. Reproduced by execution: a `manager`, correctly
   blocked from `UPDATE ... SET status = 'revoked'` on the owner's
   invitation by `0007`, could instead simply
   `DELETE FROM invitations WHERE token_hash = '...'` on that exact row and
   succeed — the weaker action (revoke) was guarded, the destructive one
   (delete) wasn't, letting a manager route around the revoke guard via
   delete-and-recreate. `0008` adds the same
   `role <> 'owner' or has_role_in_current_structure(array['owner'])` guard
   used on `invitations_update`/`invitations_insert`/`memberships_delete`.

   Same migration (`0008`) also fixes **M-B**: `invitations.status` and
   `expires_at` had no state machine. Reproduced by execution: owner sets
   `status = 'revoked'`, then a manager sets `status = 'pending'` on the
   SAME row (token_hash unchanged), making the original invitation link
   valid again; a manager could also extend `expires_at` on an
   expired/revoked row to resurrect it; a manager could set
   `status = 'accepted'` directly with no membership ever created. Fixed by
   extending `invitations_immutable_fields_guard()` to (1) freeze
   `expires_at` on UPDATE, same as the other identity columns, and (2)
   enforce that `status` may only change away from `pending` — once a row's
   status is `accepted`, `revoked` or `expired` (the enum's three terminal
   values), no further `status` change is accepted; re-issuing is
   revoke-and-recreate via the guarded INSERT path only.

   Validated by execution against a disposable `postgres:16-alpine`
   container, full chain 0000→0008 (business) + identity 0000→0001,
   superuser (Supabase-style BYPASSRLS) migrator only: (a) manager DELETE
   on the owner's invitation blocked, (b) owner DELETE on their own/another
   owner's invitation still works, (c) manager DELETE on a non-owner-role
   invitation they created still works, (d) owner revokes, manager then
   attempts `status = 'pending'` on the same row — blocked, (e) manager
   extending `expires_at` — blocked, (f) `pending -> revoked` and
   `pending -> accepted` both still reachable (no app-layer caller exists
   for `accepted` yet, but the DB layer doesn't seal it off). Full prior
   exploit suite re-run with zero regression, using the security-reviewer's
   exhaustive 4-verbs-times-all-tenant-tables sweep as the checklist: C1,
   C2, H2, H3, H-A, H-D, H-E, H-F, H-H, M-A, owner-lockout, M1. DELETE on
   `memberships` re-confirmed unchanged (0004's owner guard still holds);
   DELETE on `structures` re-confirmed correctly unreachable for every role
   including owner (no policy exists for that command on that table, so
   RLS denies by default rather than allowing it).
2m. **`ALTER DEFAULT PRIVILEGES` (0005, M-A) has no `FOR ROLE` clause —
   documented, not code-fixed.** Per Postgres semantics, `ALTER DEFAULT
   PRIVILEGES` with no `FOR ROLE` clause already implicitly applies "for
   objects subsequently created by the role running the statement" — there
   is no role-agnostic default to begin with, so adding an explicit
   `FOR ROLE <name>` would only hardcode today's migrator role's name into
   the migration, not add any missing guarantee. The real-world implication
   is: if the migrator role is ever renamed or replaced by a different
   role, that new role's default privileges are NOT covered by 0005's
   statement and it would need to be re-run (or a new statement added) `FOR
   ROLE <new name>` explicitly. Given the H-G decision above — the migrator
   role is now fixed to a stable Supabase-style project-owner role
   (`postgres`), never a rotating or renamed non-superuser role — this
   constraint is accepted and documented here rather than coded around.
2e. **Step-up/OTP for role changes — still open, not built.** Promoting or
   demoting a membership has no step-up/OTP gate yet (no provider wired,
   per CLAUDE.md D5). RLS (now hardened, see 2b) and the app layer's
   per-operation authz are today's only controls on that action. Flag
   before this ships to a real client.
2f. **Schema-wide default-privilege over-grant, closed in `0004`.** 0001's
   `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... ON TABLES TO
   app_user` is schema-wide by construction (Postgres has no table-name
   filter for this clause), so it silently handed app_user full CRUD on
   every future table in `public` — including Better Auth's
   `user`/`account`/`verification` tables, which is why
   `src/modules/identity/migrations/0001_tighten_grants.sql` had to claw
   privileges back by hand with no guaranteed run-order relative to the
   business pipeline. `0004` REVOKEs the default-privilege clause itself
   (existing tables keep their already-granted, one-time privileges —
   unaffected); from `0004` onward, any new table — business or otherwise —
   gets no app_user grant until its own migration explicitly adds one. Any
   future business-table migration must pair `CREATE TABLE` with its own
   `GRANT select, insert, update, delete ON <table> TO app_user;` alongside
   its RLS policies. The identity module's manual REVOKE workaround
   (`0001_tighten_grants.sql`) stays in place as defense in depth and is
   harmless after this fix; its "operational caveat" about pipeline
   ordering is narrowed (nothing left to re-widen a table created after
   `0004` runs) but not fully eliminated if identity migrations run between
   business `0001` and `0004` on a given environment — flagged for
   devops/db-supabase as a sequencing concern, not a schema one.
3. **Superseded by migration `0003_tighten_rls_audit_security.sql`:** the
   original `structures_insert`/`memberships_insert` policies here were
   permissive (`with check (true)` / a zero-members bootstrap branch) and
   relied on app code to immediately insert the owner membership in the same
   transaction — which was also an unrestricted-tenant-creation hole (M9) and
   let the same "zero members" branch be abused for self-escalation (H1).
   0003 closes both: direct `INSERT` on `structures` is now denied outright,
   and `create_structure_with_owner(...)` (`SECURITY DEFINER`) is the only
   supported way to create a tenant — it creates the structure row and its
   first `owner` membership row atomically, so a structure can never exist
   with zero members in the first place. (The claim that once orphaned, a
   structure "becomes permanently inaccessible through RLS" no longer
   applies — bootstrap can't produce an orphaned structure anymore.)
4. **No DGI/certified e-invoicing integration** (per CLAUDE.md D4) —
   `tax_settings`/`document_counters` are schema-ready config, not wired to
   any fiscal device. Flag before any client engagement in Senegal (VAT
   e-invoicing legally required for VAT-liable businesses per the 2025
   finance law) or Guinea (status to confirm locally).
5. Every new RLS policy and the `audit_log`/PII-adjacent columns here
   (`customers.phone`, `suppliers.phone` — clear-text E.164, tenant-scoped,
   no HMAC per the project's D7 decision) should get an explicit
   `security-reviewer` pass before merge, per CLAUDE.md's workflow.
2p. **`structure_settings` (0009) RLS granularity — flagged, not fixed, by
   design consistency with `tax_settings`.** This new table holds
   `sod_threshold_minor` (NULL = separation-of-duties disabled, the approved
   default) and `max_discount_pct`. Its RLS policy is the generic tenant
   floor (`tenant_access(structure_id)` for all commands), same as every
   table in 0001's `tenant_tables` loop, including `tax_settings` — which
   means ANY active member of the tenant (a `cashier`, a `stock_keeper`) can
   currently UPDATE this row, including raising/clearing the SoD threshold
   that is supposed to constrain them. The architect's decision was that
   only an `owner` may enable/tune SoD; that restriction is NOT encoded at
   the DB layer here, deliberately, to stay consistent with how
   `tax_settings` (equally sensitive — VAT rate, legal mentions) already
   works under the same generic-floor convention — RLS not encoding
   per-role write rules for generic tables is a project-wide convention
   (db/README's "RLS — the floor, not the ceiling" section), not an
   oversight specific to this table. The app layer MUST gate writes to
   `structure_settings` to `owner` only. Flag for `security-reviewer`
   alongside whether this whole class of generic-floor sensitive-config
   tables (`tax_settings`, `structure_settings`) should get owner-only RLS
   policies instead of relying entirely on the app layer, independent of
   this specific migration.
2q. **`stock:oversell` permission (0009) has no schema representation —
   decided, not an omission.** The architect's plan + the user's approved
   decision require a permission-gated, per-operation override for
   confirming a sale that would oversell stock (reserved to
   manager/owner), explicitly NOT a structure-level toggle. No column/table
   was added for it: it is enforced entirely in the app layer's per-
   operation authz check (same non-negotiable as every other role-gated
   write in this schema) and every use is expected to go through the
   existing `audit_log_append(...)` (0001) so it is auditable without new
   DB surface. A structure-level `allow_negative_stock` flag was
   deliberately rejected — it would bypass the per-operation/per-permission
   design the user explicitly asked for.
2r. **`stock_movements.source_type`/`source_id` partially retired (0009,
   architect option A2) — CLOSED in full by `0014`.** The 'sale' case got a
   dedicated, composite-FK'd `sale_id` column in 0009 with a CHECK enforcing
   mutual exclusivity/consistency with the legacy pair; `source_type`/
   `source_id` remained for sources without a dedicated table yet (`manual`,
   `adjustment`). `0014` finishes the job in one shot rather than three more
   follow-ups: it adds `transfer_id` (composite-FK'd to the new
   `stock_transfers`) and `stock_count_id` (composite-FK'd to the new
   `stock_counts`), adds `supplier_delivery_id` as a column now — ahead of
   the `supplier_deliveries` table itself, which ships in a later phase, so
   that table's own migration only needs to add the FK, not touch this
   constraint again — and replaces
   `stock_movements_source_consistency_chk` with
   `stock_movements_exclusive_arc_chk`: exactly one of `(sale_id,
   transfer_id, stock_count_id, supplier_delivery_id, (source_type,
   source_id))` may be set, using `num_nonnull(...) = 1`, with
   `source_type` narrowed to `('manual', 'adjustment', 'opening')`. Verified
   by execution against the full 0000→0014 chain: each of the five valid
   single-source shapes (sale / transfer / stock count / legacy manual /
   legacy adjustment) inserts cleanly; a row with zero sources set, and a
   row with two sources set (e.g. both `sale_id` and `transfer_id`), are
   both rejected with a `check_violation`. `source_type = 'opening'` is a
   new allowed value (for future opening-balance stock, not wired to any
   use case yet) — added here because the exclusive-arc rewrite was the
   natural place to also narrow/enumerate it rather than leave `source_type`
   an unconstrained free-text column going forward.
2s. **`payments`/`sales` payment linkage gap, fixed in `0010`.** Implementing
   `confirmSale` (Phase 1 step 3) surfaced that 0009 added
   `sales.payment_status` but nothing linked a payment collected AT
   sale-confirmation time back to the sale it paid for — `invoices.sale_id`
   exists, but "tickets by default, invoice on demand" means no invoice
   exists yet when a cashier takes payment at the till. `0010` adds
   `payments.sale_id` (nullable, composite-FK'd, same shape as
   `stock_movements.sale_id`) and `sales.paid_minor` (mirrors
   `invoices.paid_minor`, app-maintained running total, with a
   `sales_paid_le_total_chk` CHECK mirroring `invoices_paid_le_total_chk`).
   Both additive, idempotent, backward-compatible — no RLS/grant change
   needed (both tables already sit under the generic tenant-floor policies
   and 0001 grants).

   **Correction (coordinator feedback, Phase 1 step 4):** this entry
   previously described `confirmSale`'s domain layer as requiring an
   identified `customer_id` only for a PARTIAL payment, not for a
   fully-unpaid (zero payment) credit sale, framing that as a "deliberate
   asymmetry carried over from the architect's plan". That was wrong — it
   was an unintentional gap in the spec, not a deliberate rule. A
   fully-unpaid sale opens a receivable for the WHOLE total, which is
   exactly the scenario a customer-less receivable must never exist for.
   Fixed in `confirm-sale.ts`: ANY sale left with an unpaid balance (zero
   payment OR partial payment) now requires an identified `customer_id`;
   only a FULLY paid sale (no balance left at all) may be anonymous.
   Covered by a dedicated test in `confirm-sale.integration.test.ts`.
2t. **`issueInvoiceForSale` idempotency gap, fixed in `0011`.** The user's
   own spec for this use case (Phase 1 step 4) says "asking twice for the
   same sale returns the existing invoice rather than burning a second
   number" -- a plain "SELECT invoice WHERE sale_id = X, INSERT if none
   found" is exactly the check-then-act race `confirmSale`'s own header
   comment warns against, just one level up: two concurrent requests for
   the same sale could both pass the SELECT and both INSERT, burning two
   invoice numbers for one sale. `0011` adds a partial unique index on
   `invoices(structure_id, sale_id) WHERE sale_id IS NOT NULL`, so
   `issueInvoiceForSale` uses the SAME `ON CONFLICT ... DO NOTHING
   RETURNING *` -> re-SELECT-on-conflict pattern as `confirmSale`, which
   IS race-free. Partial (not a plain unique constraint on the column)
   because a standalone invoice with no prior ticket -- `sale_id = NULL` --
   must remain insertable any number of times (Postgres treats multiple
   NULLs in a unique index as distinct, and the `WHERE` clause also makes
   the index a valid `ON CONFLICT` inference target). Not reached by any
   code in this phase (no "create a standalone invoice with no sale" use
   case is built), but the schema already allowed it (`invoices.sale_id`
   nullable since `0000`) so the index should not break it.
2u. **`settings:write` silent no-op for `manager` once a settings UI exists
   -- documented as DEBT, not fixed (security-reviewer cleanup round,
   item L-d).** `0013`'s owner-only RLS policies on `structure_settings`/
   `tax_settings` are strictly stricter than the app-layer permission
   matrix: a `manager` role currently holds `settings:write` (application
   layer), but the DB layer will reject their INSERT/UPDATE/DELETE on
   these two tables regardless. No screen exists yet that lets a manager
   attempt this, so today it is a latent inconsistency, not a live bug --
   but the day a settings screen is built, a manager's save will either
   silently affect 0 rows (UPDATE on an existing row) or throw a raw RLS
   error surfaced as a generic 500 (INSERT, no row yet), neither of which
   is an acceptable UX. Before shipping such a screen: either (a) narrow
   `settings:write` so only `owner` holds it (simplest, matches the DB
   today), or (b) relax `0013`'s policies to match `settings:write`
   holders and accept that H4's original threat model (a manager
   self-approving a SoD threshold change) returns.
2v. **Step-up re-authenticates the SAME actor -- documented as DEBT, not
   fixed (security-reviewer cleanup round, item L-e).** `requireStepUp`
   (H4 fix) exists only to fail closed today (`StepUpNotImplementedError`,
   unconditionally thrown -- no OTP provider wired, per D5) and is
   intentionally NOT a real second-validator check. CLAUDE.md's D3 is
   explicit that double-validation on sensitive actions (discount above
   threshold, cash-void, override) must be validated by a SECOND person,
   not a re-authentication of the same session's actor. Whoever
   eventually wires D5's `OtpSender`/`NotificationSender` MUST NOT treat
   "step-up succeeded" as satisfying D3 unless the OTP/approval is
   actually routed to and approved by a distinct user with the
   appropriate role -- otherwise SoD becomes a checkbox a single
   dishonest actor can tick for themselves.
2w. **No logout button anywhere in the app -- documented as DEBT, not
   fixed (security-reviewer cleanup round, same item as L-c/L-e
   write-up).** `src/lib/offline-sales-queue.ts` exports `purgeScope(
   scopeKey)` specifically so a logout flow can wipe that user's queued
   offline sale intents (idempotency keys, cart contents) from IndexedDB
   on sign-out, rather than leaving them on a shared/kiosk device for the
   next person logged into that till. The function is correct and
   tested, but nothing calls it today because there is no logout
   affordance in the UI at all (Better Auth session simply expires).
   Must be wired before this app is used on any shared/kiosk hardware,
   not just personal phones.
2x. **Multi-store store-scope RLS (`0014`) -- floor/ceiling split, and a
   deadlock-ordering requirement for the app layer, both deliberate, both
   flagged here rather than coded around.**

   **No new GUC.** Store scope is derived exclusively from
   `memberships.warehouse_id` via a new SECURITY DEFINER STABLE helper,
   `app_scoped_warehouse_id()` — reads the exact same row
   `has_role_in_current_structure()` already re-verifies the role against,
   for `(app_current_user_id(), app_current_structure_id())`,
   `status = 'active'`. NULL = all-stores scope (an `owner`, or any
   membership left unscoped). A THIRD session GUC (`app.warehouse_id`) was
   explicitly rejected as a new forgeable attack surface — this helper has
   zero spoofing surface beyond what already exists for the role check,
   because it reads from the same authoritative row and is only ever
   reached after `tenant_access(structure_id)` has already re-verified a
   real active membership (the generic floor's `AND` short-circuits a
   forged/absent GUC before the warehouse-scope `OR`-branch is evaluated).
   `EXECUTE` is revoked from `PUBLIC` and granted only to `app_user`,
   verified BOTH by an explicit per-function `REVOKE`/`GRANT` (belt-and-
   suspenders, same convention as every other SECURITY DEFINER helper) AND
   by a migration-time assertion that checks `has_function_privilege
   ('public', ...)` is false BEFORE that explicit revoke runs — proving
   `0005`'s global `alter default privileges ... revoke execute on
   functions from public` (fix-round #3, entry 2c) still holds for a
   function created four migrations later, in `0014`, not just for the
   functions created in the same migration that first added it.

   **Floor, not ceiling, and only on tables read on a store-scoped
   dashboard.** The predicate `app_scoped_warehouse_id() is null or
   warehouse_id = app_scoped_warehouse_id()` (OR'd across BOTH
   `from_warehouse_id`/`to_warehouse_id` for `stock_transfers`, since a
   transfer is legitimately visible from both its origin and destination
   gerant) is added to `stock_movements`, `stock_levels`, `sales`,
   `payments`, `stock_transfers`, `stock_counts` — every table that carries
   a `warehouse_id` directly. It is **deliberately NOT denormalized** onto
   `sale_lines`, `invoices`, `payment_allocations`, `stock_transfer_lines`
   or `stock_count_lines`: those are only ever reached by joining an
   already store-scoped parent row, and a correlated
   `EXISTS`-against-the-parent evaluated per row in a line table's own
   policy would defeat the index-only dashboard aggregates that scan those
   tables directly (top products, 30-day windows, per-seller breakdowns).
   Store scope for the line tables is **app-ceiling only** — same
   established convention as the existing tenant-floor-only treatment of
   those tables, not a new gap introduced by this migration. `payments`
   specifically is included in the scoped set (not left floor-only like the
   other line-shaped tables) because treasury-per-store is an explicit
   product requirement and it puts an RLS floor on the most sensitive money
   path; its `warehouse_id` is backfilled from `sales.warehouse_id` via
   `sale_id`, falling back to the structure's default store, then to any
   store in the structure — a payment that still can't resolve one (a
   structure with zero warehouses at all, an edge case for a billing-only
   tenant that never touched stock) is left `NULL` and becomes invisible to
   any store-scoped gerant under the new predicate, visible only to an
   unscoped (owner) member; this is a fail-closed degradation, not a leak,
   and is logged via a `RAISE NOTICE` at migration time naming the row
   count if it ever occurs.

   **Deadlock-ordering requirement for the app layer — NOT fixable in this
   migration, flagged for whoever implements transfer confirmation.** The
   existing inventory repository's lock ordering is by `product_id` alone.
   With multi-store active, two CROSSED transfers — A→B and B→A, confirmed
   concurrently, touching an overlapping set of products — can deadlock
   under that ordering: transaction 1 locks `product_id = X` while applying
   the outgoing leg at warehouse A, transaction 2 locks the same
   `product_id = X` while applying the outgoing leg at warehouse B, and each
   then blocks waiting for the other's incoming-leg lock at the opposite
   warehouse. Lock ordering must become `(product_id, warehouse_id)`
   (consistently sorted before acquiring row locks on `stock_levels`/
   `stock_movements`) wherever the repository takes a per-product lock to
   apply a movement, transfer leg or count line. This is an application-
   code fix, not a schema one, so it could not be made by this migration —
   documented here so the implementer of `confirmTransfer`/`receiveTransfer`
   does not miss it and reproduce 0010/0011/0012's "fixed across three
   follow-ups" pattern this migration's own brief was written to avoid.

   Both the RLS rewrite and the exclusive-arc rewrite (entry 2r) were done
   once, in this single migration, as scoped.
2y. **Supplier purchasing (`0015`) -- floor/ceiling split, mirroring 2x,
   restated per this migration's own brief instruction to document it
   again.** `supplier_deliveries` is FLOOR-scoped with the same store
   predicate as `stock_transfers`/`stock_counts` (it carries `warehouse_id`
   directly and is read on a store-scoped dashboard). `supplier_delivery_
   lines` is floor-only (line table, same convention as `sale_lines`/
   `stock_transfer_lines`). `supplier_payments` is **deliberately** floor-
   only with **no store predicate and no `warehouse_id` column at all** --
   the architect's product decision is that supplier debt is consolidated
   at TENANT level (a gerant sees the deliveries that landed in their own
   store, never the global supplier balance), and a single payment may
   settle deliveries across several stores at once via
   `supplier_payment_allocations` (also floor-only, mirrors the existing
   `payment_allocations`). Verified by execution against a disposable
   `postgres:16-alpine` container: a `manager` membership scoped to store A
   sees exactly the `supplier_deliveries` row delivered into store A (count
   = 1), the symmetric manager scoped to store B sees only store B's row,
   an unscoped `owner` sees both (count = 2); `supplier_payments` returns
   the SAME row count for the store-A-scoped manager as for the owner
   (count = 1 each) -- confirming it is NOT store-filtered, by design.
   `supplier_deliveries_paid_le_total_chk` (mirrors `invoices_paid_le_
   total_chk`): `paid_minor = total_minor` succeeds, `paid_minor >
   total_minor` -- `check_violation`. Cross-tenant `supplier_id` on
   `supplier_deliveries` -- `foreign_key_violation`; same-tenant --
   succeeds. `app_scoped_warehouse_id()` and `stock_movements.supplier_
   delivery_id`'s composite FK (activated here; 0014 added the column
   specifically so this migration's only job on that column is the FK) both
   confirmed working. `app_user`'s grants on all four new tables are
   exactly select/insert/update/delete, confirmed via
   `information_schema.role_table_grants`. Deliberately NOT reusing
   `payments`/`invoices` for the supplier side -- those are customer-side by
   construction; adding a `party_type` column would recreate exactly the
   polymorphic reference 0009/0014 spent two migrations retiring (2r).
2z. **Rebates + global search (`0016`).**
   - `rebate_scales`'s exactly-one-party CHECK
     (`rebate_scales_exactly_one_party_chk`, `num_nonnulls(customer_id,
     supplier_id) = 1`) applies the 2r lesson preventively: two explicit
     composite-FK columns, not a `party_type`/`party_id` polymorph. Verified
     by execution: zero parties and two parties both -- `check_violation`;
     exactly one -- succeeds. A second CHECK
     (`rebate_scales_party_model_chk`) additionally pins the product
     decision that the customer side is always `monthly` and the supplier
     side is always `cyclic` -- a customer scale with `model = 'cyclic'` (or
     the reverse) is rejected the same way, confirmed by execution.
   - `rebate_grants` is a HISTORY table with a CRITICAL, STRUCTURAL
     invariant: there is no foreign key, and must never be one, to
     `payments`/`invoices`/`supplier_payments`/any balance column -- a
     rebate is informational only, never auto-deducted. Its only FK target
     is `rebate_scales`. This is enforced by what the table simply does NOT
     reference, flagged in both the migration's and the TS schema's header
     comments as the trip-wire for a security-reviewer pass if anyone ever
     adds such an FK later.
   - The monthly-only partial unique index
     (`rebate_grants_structure_scale_period_label_idx`, `unique
     (structure_id, scale_id, period_label) where model = 'monthly'`) is
     implemented with a DENORMALIZED COPY of the scale's model on the grant
     row itself (`rebate_grants.model`), copied at grant time -- Postgres
     partial-index predicates cannot reference another table via a
     correlated subquery, so the model had to live on the row being
     indexed. Verified by execution: two grants for the same scale+
     `period_label` under `model = 'monthly'` -- second insert is a
     `unique_violation`; two (or more) `model = 'cyclic'` grants for the
     same scale with `period_label` left NULL -- both/all insert cleanly
     (Postgres never treats multiple NULLs as duplicates in a unique index).
   - `rebate_grants_granted_by_trigger_chk` (`(trigger = 'manual') =
     (granted_by is not null)`): an `auto`-triggered grant with a non-NULL
     `granted_by` -- `check_violation`, confirmed by execution; the valid
     "auto, no human actor" and "manual, named actor" shapes both insert.
   - `pg_trgm` installed in `extensions` (not `public` -- 0004's convention,
     avoids reopening the PostgREST/Data-API surface C2 closed), with GIN
     indexes on `products(name)`, `products(sku)`, `customers(name)`,
     `customers(phone)`, `suppliers(name)`. `EXECUTE` on every function in
     `extensions` (pg_trgm's own, and pgcrypto's, re-asserted) is revoked
     from PUBLIC and granted to `app_user` only -- confirmed by execution:
     `has_function_privilege('public', 'extensions.similarity(text,
     text)', 'execute')` is `false`, `has_function_privilege('app_user',
     ...)` is `true`, and a real trigram query
     (`... where name OPERATOR(extensions.%) 'riz'`) executes successfully
     under `app_user` with RLS active.

     **Judgment call flagged for security-reviewer:** unlike pgcrypto's
     functions (only ever reached transitively through a SECURITY DEFINER
     function, so `app_user` never needed direct EXECUTE on them), pg_trgm's
     `%`/similarity operators are invoked under the CALLING role's own
     privileges -- `app_user` needs EXECUTE directly, including on several
     undocumented GIN-opclass support functions. Rather than hand-enumerate
     pg_trgm's ~20 functions (several of them Postgres-internal and subject
     to change across minor versions), this migration grants EXECUTE on
     ALL functions in `extensions` to `app_user` -- which also hands it
     pgcrypto's functions it did not have before. Accepted: `app_user` is
     already the single fully-trusted, fully-tenant-scoped app-facing role
     with full CRUD on every business table; this is not a privilege
     escalation relative to what it already controls, and the actual
     security boundary (no PostgREST/anon exposure, PUBLIC locked out) is
     unaffected -- confirmed PUBLIC still cannot execute anything in
     `extensions`.
   - `customers` gained `is_active`, `credit_limit_minor`,
     `default_payment_terms_days`, `address`, `notes` for the clients
     screen. `address`/`notes` are free-text and not E.164 phone, so D7's
     "no HMAC, clear text, tenant-scoped" decision doesn't literally apply,
     but they are still customer PII/business-sensitive by nature (a
     customer's address, free-text notes a cashier might write about them)
     -- flagged for security-reviewer alongside every other PII-adjacent
     column in this schema (entry 5), same tenant-floor RLS as the rest of
     `customers`, no new column-level restriction added.

   Validated by execution against a disposable `postgres:16-alpine`
   container, full chain 0000->0016 (business) + identity 0000->0001:
   `app_user`'s grants on `rebate_scales`/`rebate_tiers`/`rebate_grants` are
   exactly select/insert/update/delete. Condensed cumulative exploit suite
   (C1, H-D, H-A, H-F, H-I) re-run with zero regression. Both down scripts
   (0016 then 0015) applied against the full 0000->0016 chain including
   drizzle's own journal-row cleanup (see "Rollback keeps drizzle's own
   journal honest" above); a partial rollback (down 0016, down 0015, then
   `migrate:all`) re-applied exactly those two migrations and left
   0000-0014's objects untouched, confirmed by re-running
   `scripts/ci/verify-business-schema.sql`. A full reverse sweep (every
   `down/*.down.sql`, highest-numbered first, down to `0000`) followed by a
   fresh `migrate:all` (business + identity) was also run end-to-end and
   re-applied all 17 business migrations + 2 identity migrations correctly,
   confirming 0015/0016 introduced no regression in that whole-chain cycle
   either -- see the new "`meta/_journal.json` is the real source" section
   above for the one real gap this exercise found (not a regression in
   0000-0014's own down scripts, but a gap in how a BRAND NEW hand-written
   migration gets picked up at all, which 0015/0016 hit first simply by
   being the first ones added since that mechanism was last exercised).
