# Platform layer — how the pieces fit together

This is the map for whoever builds the next business module (catalog,
inventory, sales, billing, ...) on top of the authn/authz foundation. Read
`db/README.md` first (schema, RLS, audit trail); this file is about the
Next.js app layer on top of it.

## Request flow, end to end

Every tenant-scoped page/action follows the same five-step chain. The
demonstrative Server Action (`src/app/s/[structureId]/dashboard/actions.ts`,
`updateStructureDisplayName`) and the dashboard page
(`src/app/s/[structureId]/dashboard/page.tsx`) both do exactly this, in this
order, and so should every business-module Server Action / Route Handler:

1. **`getSession()`** (`src/modules/identity/get-session.ts`) — resolves the
   Better Auth session from the request's cookies. Returns `null`, never
   throws; callers decide what to do (redirect to `/login`, etc.).
2. **`resolveActor(session, structureId)`**
   (`src/modules/tenancy/resolve-actor.ts`) — turns a client-supplied
   `structureId` (from the URL) into a verified `Actor { userId,
   structureId, role }` by actually querying `memberships` under RLS, scoped
   to the session's real `userId`. Throws `UnauthenticatedError` /
   `NotAMemberError` on failure. **This is the only place a URL segment is
   allowed to become tenant context** — never read `structureId` off the URL
   and use it directly for a query or a permission check.
3. **`assertCan(actor, permission)`**
   (`src/modules/tenancy/permissions.ts`) — the per-operation authorization
   ceiling on top of RLS's floor. Fail-closed: a role not explicitly granted
   a permission is denied. Extend the `MATRIX` object (or compose a
   module-scoped matrix) as business modules add permissions — don't bypass
   it with ad-hoc role checks in a route handler.
4. **`withTenantSession(actor, fn)`**
   (`src/platform/db/withTenantSession.ts`) — the *only* way to touch
   tenant-scoped tables. Opens one Postgres transaction, sets
   `app.structure_id`/`app.user_id` via `set_config(..., true)` (transaction-
   local), and hands `fn` a `{ db, audit, actor }` context scoped to exactly
   that transaction. Never import `db`/`pgClient` from `src/db/index.ts`
   directly in business code to query a tenant table — that connection has
   no tenant context and RLS will default-deny it (verified live: see
   "What was actually tested" below), which is correct but will just look
   like "no rows", not an obvious bug.
5. **`audit.append({ action, targetType, targetId, payload })`**
   (`src/platform/audit/audit-writer.ts`) — call this from *inside* the same
   `withTenantSession` callback, after the write, for any action that is
   sensitive per CLAUDE.md (rights changes, validations, financial events,
   cancellations/overrides). It runs in the same transaction as the business
   write, so one can't commit without the other.

## Identity vs. tenancy vs. business data

- **Identity** (`src/modules/identity/`): Better Auth's own tables
  (`user`/`session`/`account`/`verification`), schema in
  `src/modules/identity/schema.ts`, migrated independently by
  `src/modules/identity/migrate.ts` (`npm run identity:db:migrate`, migrator
  role). Global, not tenant-scoped, **no RLS** — the only code path that
  touches these tables is Better Auth's own request handler
  (`src/app/api/auth/[...all]/route.ts`). Never query `user`/`session`
  directly from business code; go through `getSession()`.
- **Tenancy** (`src/modules/tenancy/`): `resolveActor`, the permission
  matrix, and `listMyMemberships` (the one pre-structureId read, via the
  `my_memberships()` SQL function added in
  `src/db/migrations/0002_my_memberships.sql`).
- **Business schema** (`src/db/schema/*`, owned by the db-supabase agent):
  everything tenant-scoped, RLS floor already enforced at the DB level.

## URL shape (judgment call, flag for review)

Structure-scoped pages live at `/s/[structureId]/dashboard` using the
structure's **raw UUID**, not a slug — `structures` has no slug column in
the current schema. This is a deliberate placeholder: if/when a human-
readable slug is added to `structures`, swap the URL segment and update
`resolveActor`'s lookup to resolve slug → id first (still re-verified
against `memberships`, same as today) — nothing else in the chain changes.

`/s` (no structureId) is the post-login landing page: it calls
`listMyMemberships()` and either redirects straight to the one structure the
user belongs to, or shows a picker. This exists because the RLS policy on
`memberships` requires `structure_id = app_current_structure_id()` — i.e. the
caller must already know which structure to ask about — which makes a plain
"list all of my memberships across every structure" query impossible under
the floor policies alone. `my_memberships()` is a narrow, user-id-only
SECURITY DEFINER escape hatch for exactly that one need; don't reuse this
pattern for anything broader without a fresh security-reviewer pass.

## What was actually tested (not just read)

Against a throwaway `postgres:16-alpine` container (business migrations +
identity migrations both applied with the migrator role, `app_user`
password set out-of-band), with `next build` and `next dev` running:

- Sign-up via `POST /api/auth/sign-up/email` created a real `user` row
  through the Drizzle adapter and the hand-written identity schema, and
  returned a valid session cookie.
- `/s` → `/s/<id>/dashboard` redirect chain worked for a seeded owner
  membership, rendering the real structure name and role server-side.
- The `updateStructureDisplayName` chain (`resolveActor` →
  `assertCan('settings:write')` → `withTenantSession` → update + audit
  append) was exercised directly against the live DB: the rename committed,
  `audit_log_verify()` reported the chain intact (`null`) after the new
  entry.
- `resolveActor` correctly threw `NotAMemberError` for a structureId the
  authenticated user has no active membership in.
- `assertCan` correctly threw `ForbiddenError` for a `cashier` actor
  attempting `settings:write`.
- A raw `db.select()` against `structures` with no tenant GUC set returned
  **zero rows** (RLS default-deny holds for `app_user` outside
  `withTenantSession`).
- A direct `INSERT` into `audit_log` as `app_user` was rejected with
  "permission denied for table audit_log" (the REVOKE from
  `0001_tenancy_rls_audit.sql` holds; appends only work through
  `audit_log_append()`).

## Build-time env requirement

`next build` imports every route module during its "Collecting page data"
step, even for routes marked `force-dynamic` -- which means `DATABASE_URL`
and `BETTER_AUTH_SECRET` must be set at **build** time, not just at runtime
(confirmed: deleting `.env` after a successful build made a subsequent
`npm run build` fail with "DATABASE_URL must be set" while collecting page
data for `/s`). This is normal on Vercel (env vars are available at build
time there too) but worth knowing for any other CI/CD pipeline.

## Business modules (Phase 1, step 1) -- hexagonal skeleton + transaction convention

`src/modules/{catalog,inventory,sales,billing,analytics}/` each follow the
same hexagonal layout:

- `domain/` -- pure TS entities/value objects/errors. No drizzle, no Next
  imports, no `@/db/schema/*` -- enforced by an ESLint `no-restricted-imports`
  override (see `.eslintrc.json`), not just a convention.
- `application/` -- use cases + repository PORTS (interfaces). A use case's
  FIRST line is `assertCan(ctx.actor, "...")` -- never in the route handler
  / Server Action. Takes a `TenantSessionContext` (`ctx`) as its first
  parameter; never opens its own `withTenantSession`.
- `infrastructure/` -- the drizzle implementation of each port. The ONLY
  layer of a module allowed to import that module's own `@/db/schema/*`
  file (cross-module schema imports, e.g. sales importing
  `@/db/schema/inventory`, are forbidden by the same ESLint rule).
- `api/` -- thin `"use server"` Server Actions: `getSession()` ->
  `resolveActor()` -> `withTenantSession(actor, ctx => moduleService.useCase(ctx, input))`.
  No business logic, no `assertCan` here.
- `index.ts` -- the module's public service surface (e.g. `catalogService`,
  `inventoryService`). The ONLY way another module may reach this one --
  never that module's `domain/`/`infrastructure/` directly, enforced by the
  same ESLint rule. Example: `inventory/application/list-low-stock.ts` calls
  `catalogService.listProducts(ctx, ...)` from `@/modules/catalog` to read
  `products.low_stock_threshold`, instead of importing
  `@/db/schema/catalog`.

**Transaction convention**: only the TOP-LEVEL use case opens
`withTenantSession` (in its own module's `api/` Server Action). It passes
the resulting `TenantSessionContext` down to any other module's service
function it calls (e.g. a future `sales.confirmSale` will call
`inventoryService.applyStockOut(ctx, ...)` and `catalogService.getProduct(ctx,
...)` with the SAME `ctx`). A callee must NEVER open its own
`withTenantSession` -- `inventoryService.applyStockOut`/`reverseStockOut`
are written exactly this way: they take a caller-provided `ctx` and do not
start a transaction.

**Money/quantity DTO boundary**: `bigint` (every monetary column, D8) is not
JSON-serializable across the RSC/Server-Action boundary, and
`numeric(18,4)` quantity columns come back from the driver as strings, not
numbers. Two small, explicit conversion layers exist from day one so this
is never discovered at runtime:
- `@/platform/dto/money.ts` -- `moneyToDto(bigint): string` /
  `moneyFromDto(string): bigint`. Domain/application code stays `bigint`;
  DTOs returned to a Server Action caller or passed into a component are
  always `string`.
- `@/modules/inventory/domain/quantity.ts` -- the `Quantity` value object.
  All arithmetic is done on an internal fixed-point `bigint` (scaled by
  10 000, numeric(18,4)'s 4 decimal places) -- `Number()` is never called on
  a quantity anywhere in this codebase. Re-exported through
  `@/modules/inventory`'s index so other modules can use it without
  reaching into `inventory/domain` directly.

**Permission matrix / scope**: `src/modules/tenancy/permissions.ts` now
carries the full business permission set (catalog/inventory/sales/billing/
analytics/audit), plus `scopeFor(actor, permission) -> "own" | "all"` --
e.g. a cashier with `sale:read` but not `sale:read_all` gets `"own"`, which
a repository's scope parameter (required, not optional, once sales/billing
land) uses to filter to the actor's own rows. `requireStepUp(actor, reason)`
(`@/modules/tenancy/step-up.ts`) is a seam for a future OTP-gated action --
it throws today (no provider wired yet, interim control is password
re-auth) rather than silently approving anything.

## Billing (Phase 1 step 4) and analytics (step 5)

`billing` grew two generations of use cases in the SAME module: the
ctx-based primitives `confirmSale` needs (`getVatRate`,
`allocateTicketNumber`, `recordSalePayment`) from step 3, and now the
standalone, top-level use cases from step 4 (`recordPayment` -- pay off a
credit sale later, own transaction, own idempotency key;
`issueInvoiceForSale` -- "invoice on demand", idempotent-ish via a partial
unique index (migration 0011), own gapless `document_counters` sequence
(`doc_type='invoice'`, never shares a sequence with tickets);
`voidPayment` -- reverses a payment's effect on the sale and, if one
exists, the invoice it was allocated against; plus the read side
`listInvoices`/`getInvoice`/`listPayments`/`getReceivables`). `sales`
gained a few more ctx-based primitives for billing to call with its OWN
ctx (`getSaleForBilling`, `recordPaymentProgress`, `listOpenSalesForBilling`)
-- same cross-module convention as inventory's `applyStockOut`, just used
in the other direction (billing calling sales, not sales calling
inventory).

`analytics` (`getDashboard`) is READ-ONLY and deliberately breaks the
strict per-module schema-ownership convention: its `infrastructure/`
queries `sales`/`sale_lines`/`payments`/`warehouses` directly via raw SQL
(`ctx.db.execute(sql\`...\`)`), never through each module's narrow
CRUD-oriented service surface -- a cross-cutting reporting module
aggregating data owned by several other modules cannot reasonably be
forced through those surfaces for a dashboard, and the coordinator's own
instruction ("direct indexed queries, no materialized view") implies
exactly this. It still goes through `billingService.getReceivables`/
`getVatRate` and `inventoryService.listLowStock` for the pieces those
modules already expose cleanly. Every query for a `getDashboard` call runs
inside ONE `withTenantSession`, fired in parallel via `Promise.all` --
but ONLY the figures gated on `dashboard:read_financials` are even
queried; an actor without it never has those queries issued at all (not
"computed then hidden").

**Revisit trigger for the direct-indexed-query approach**: if a tenant's
p95 dashboard query latency exceeds 300ms, or a single tenant's
`sale_lines` row count passes roughly 500k, that's the signal to introduce
a rollup table / materialized view as a SECOND implementation of the SAME
`AnalyticsRepository` port -- zero changes needed in `getDashboard` or any
page, by construction.

**Timezone assumption** (`analytics/domain/period.ts`): both Senegal and
Guinea sit at UTC+0, so "the accounting day" is defined as the UTC day --
every period boundary (day/week/month) is computed in UTC with no
local-timezone conversion anywhere in this module. Revisit this file
specifically if this product ever serves a market at a different UTC
offset.

## Known gaps / deliberate deferrals (for whoever builds the next module)

- No structure/tenant **creation** flow is built yet (the README's bootstrap
  note about inserting the structure + first owner membership in the same
  transaction, immediately, still applies — nothing here does that for you).
- No invitation-acceptance flow (the `invitations` table and its RLS exist;
  nothing reads/writes it yet).
- Error → HTTP status / UI mapping is minimal (`UnauthenticatedError` →
  redirect, `NotAMemberError` → `notFound()`, `ForbiddenError` is left to
  throw to Next's default error boundary in the demo action). A real
  business module should probably centralize this instead of repeating the
  try/catch in every page.
- Email verification is disabled in `modules/identity/auth.ts` (no
  transactional email/OTP sender wired yet — see CLAUDE.md D5). Flag before
  going to production.
