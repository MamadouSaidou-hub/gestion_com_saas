-- ============================================================================
-- Better Auth's own tables -- separate migration journal from the business
-- schema (src/db/migrations/), applied by src/modules/identity/migrate.ts
-- with the MIGRATOR role. See src/modules/identity/schema.ts for the full
-- rationale. Idempotent (IF NOT EXISTS) so re-running is safe.
--
-- No RLS here on purpose -- see schema.ts header comment (no tenant
-- dimension on these tables). app_user's grants are scoped explicitly and
-- precisely below, per-table/per-operation (C3 security-reviewer finding) --
-- do NOT rely on the business migration's schema-wide "alter default
-- privileges"/"grant ... on all tables" pattern to cover these tables; that
-- pattern re-grants broad access and should itself be narrowed over time
-- (flagged to the db-supabase agent, out of scope for this file).
-- ============================================================================

create table if not exists "user" (
  id text primary key,
  name text not null,
  email text not null,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_email_idx on "user" (email);

create table if not exists "session" (
  id text primary key,
  expires_at timestamptz not null,
  token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  user_id text not null references "user" (id) on delete cascade
);

create unique index if not exists session_token_idx on "session" (token);
create index if not exists session_user_id_idx on "session" (user_id);

create table if not exists "account" (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references "user" (id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists account_user_id_idx on "account" (user_id);

create table if not exists "verification" (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Better Auth's DB-backed rate-limit bucket table (M5 security-reviewer
-- finding) -- see schema.ts for why this is required for Vercel/serverless.
create table if not exists "rate_limit" (
  id text primary key,
  key text not null,
  count integer not null,
  last_request bigint not null
);

create unique index if not exists rate_limit_key_idx on "rate_limit" (key);

-- ----------------------------------------------------------------------------
-- Grants for app_user -- C3 (security-reviewer finding).
--
-- These four tables have NO tenant dimension, so RLS/the app.structure_id GUC
-- do not apply to them (there is nothing to scope by). That means the only
-- real lever here is the operation-level grant itself: app_user is the sole
-- runtime Postgres role (no separate Better Auth role/connection -- see the
-- judgment call below), so it necessarily has the privileges Better Auth's
-- Drizzle adapter needs to do its job. We intentionally do NOT grant the
-- blanket "select, insert, update, delete" the previous version of this file
-- granted: that's wider than what Better Auth's actual request flows use, and
-- it is silently re-widened again by the business migration's
-- "alter default privileges ... grant ... on tables to app_user" /
-- "grant ... on all tables in schema public to app_user" pattern (see
-- src/db/migrations/0001_tenancy_rls_audit.sql, owned by the db-supabase
-- agent). We cannot prevent that schema-wide re-grant from here (out of
-- scope -- different migration journal/owner), so we grant precisely what is
-- needed below and flag the "ON ALL TABLES" pattern to the db-supabase agent
-- as something that should eventually be scoped to specific tables rather
-- than schema-wide, instead of relying on the narrower grant below to be the
-- last word.
--
-- Per-table/operation rationale (verified against better-auth@1.2.x's
-- Drizzle adapter + the emailAndPassword provider actually enabled in
-- auth.ts):
--   user         SELECT  (lookup by email/id at sign-in, session hydration)
--                INSERT  (sign-up)
--                UPDATE  (email_verified/name/image/updated_at changes)
--                no DELETE: no account-deletion flow is wired in auth.ts.
--   session      SELECT, INSERT, UPDATE, DELETE -- full CRUD is genuinely
--                needed: sign-in creates a session, every authenticated
--                request may rotate/touch it (UPDATE), sign-out and revoke-
--                session both DELETE by id. This is also exactly the row an
--                attacker with arbitrary SQL as app_user would forge to
--                impersonate a user -- that risk is inherent to running
--                Better Auth through the same single role as the rest of the
--                app (see judgment call below), not something this grant
--                shape can close.
--   account      SELECT, INSERT, UPDATE -- stores the password hash for the
--                emailAndPassword provider (SELECT to verify at sign-in,
--                INSERT at sign-up, UPDATE for password change). No DELETE:
--                no unlink-provider/account-deletion flow is wired.
--   verification SELECT, INSERT, DELETE -- used for email-verification /
--                password-reset tokens: insert the token, select+delete it
--                on consumption. No UPDATE: tokens are issued once and
--                consumed once, never mutated in place. (emailVerification
--                is currently disabled in auth.ts -- see that file's header
--                comment -- so this table is effectively idle today, but the
--                grant is scoped for when it's turned on.)
--
-- Judgment call for security-reviewer: we considered a second Postgres role
-- dedicated to Better Auth's own connection, so a SQL-injection/arbitrary-SQL
-- compromise of the business app_user role could not reach these tables at
-- all. We did NOT implement that here: Better Auth runs in-process through
-- the same Next.js server and the same drizzle `db` client as the rest of
-- the app (see auth.ts), so splitting roles would mean a second DB
-- connection pool/secret/env var purely for this, while every single
-- Server Action/Route Handler in this codebase already runs as app_user and
-- would still be able to call Better Auth's own API (which itself runs as
-- app_user) to mint a session through the normal sign-in flow anyway -- a
-- second role would raise the bar for a raw-SQL injection reaching `session`
-- directly, but would NOT remove app_user's own ability to authenticate
-- (that's the point of the login feature). Given the added operational
-- complexity (new role, new secret, new pooled connection to manage/rotate)
-- against a partial mitigation, we judged the precise, minimal grant below
-- to be the right tradeoff for this stage. If a future compliance/pen-test
-- requirement raises the bar further, revisit with a dedicated
-- `app_auth_user` role restricted to exactly these four tables and nothing
-- else, with the rest of the app (`app_user`) having NO grant on them at all
-- (today's single-role setup means app_user necessarily can read/write
-- these tables since it IS the role Better Auth runs as).
do $$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'app_user') then
    grant select, insert, update on "user" to app_user;
    grant select, insert, update, delete on "session" to app_user;
    grant select, insert, update on "account" to app_user;
    grant select, insert, delete on "verification" to app_user;
    -- rate_limit: SELECT to read the current bucket, INSERT for a brand new
    -- key, UPDATE to bump count/lastRequest on an existing bucket, DELETE so
    -- Better Auth can prune/reset buckets. No tenant dimension, same as the
    -- other identity tables above.
    grant select, insert, update, delete on "rate_limit" to app_user;
  end if;
end $$;
