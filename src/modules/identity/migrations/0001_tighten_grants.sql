-- ============================================================================
-- Re-tighten app_user's DML grants on Better Auth's own tables.
--
-- WHY THIS FILE EXISTS (security-reviewer re-verification, round 2 of C3):
-- 0000_identity_core.sql granted app_user a precise, narrow set of
-- privileges on "user"/"account"/"verification"/"rate_limit" (no DELETE on
-- user/account, no UPDATE on verification -- see that file's long comment
-- for the per-table rationale). That grant is a no-op in practice, because
-- src/db/migrations/0001_tenancy_rls_audit.sql (business pipeline, owned by
-- the db-supabase agent, a SEPARATE migration journal/runner from this one --
-- see migrate.ts) contains:
--
--   alter default privileges in schema public
--     grant select, insert, update, delete on tables to app_user;
--   grant select, insert, update, delete on all tables in schema public
--     to app_user;
--
-- GRANT is purely additive in Postgres: it does not matter whether that
-- statement ran before or after 0000_identity_core.sql's narrower grant --
-- whichever ran, "user"/"account"/"verification" end up with the full
-- SELECT/INSERT/UPDATE/DELETE set, because the blanket statement grants on
-- ALL tables that exist in `public` at the time it runs (for the ones that
-- didn't exist yet, the `ALTER DEFAULT PRIVILEGES` line still covers them
-- going forward). Confirmed against a real Postgres dump of
-- information_schema.table_privileges.
--
-- ORDER IS NOT GUARANTEED BETWEEN THE TWO PIPELINES: `npm run db:migrate`
-- (business, drizzle-kit journal) and `npm run identity:db:migrate` (this
-- folder, its own `_identity_migrations` bookkeeping table) are separate
-- scripts with no enforced sequencing today (see package.json -- no combined
-- "migrate:all" script, no CI step ordering them). So instead of assuming
-- this file runs after the business 0001, we make the fix idempotent and
-- order-independent: explicit REVOKE statements. A REVOKE always wins over
-- any prior or (if this file is re-applied, which it won't be automatically,
-- see migrate.ts's one-shot-per-filename tracking) future blanket GRANT for
-- the privileges actually listed here, regardless of which migration ran
-- last.
--
-- OPERATIONAL CAVEAT (flag to devops/db-supabase, not fixable from this
-- file alone): because the two pipelines are not sequenced, if an operator
-- runs `identity:db:migrate` BEFORE `db:migrate` for the very first time on
-- a fresh database, this file's REVOKEs apply to tables that already exist
-- (fine), but the business 0001 that runs afterwards will WIDEN them again
-- via its blanket "grant ... on all tables in schema public" (since this
-- file's REVOKE already happened and nothing re-runs it). The only durable
-- fix is operational: always run `db:migrate` THEN `identity:db:migrate`,
-- in that order, every time on a given environment, OR (preferred,
-- structural) have db-supabase narrow 0001's blanket grant so it never
-- touches these four tables in the first place. This file closes the gap
-- for the common case (business migrations ran first, or run only once per
-- environment and this file re-asserts the narrow intent last) but cannot
-- by itself guarantee the invariant across every possible operator run
-- order -- see report.
--
-- Idempotent: REVOKE on a privilege the role doesn't currently hold is a
-- no-op in Postgres, not an error, so re-running this file (defensively) is
-- always safe.
--
-- FAIL LOUD, NOT SILENT, if app_user does not exist yet: this file's own
-- runner (migrate.ts) marks a file "applied" in `_identity_migrations` the
-- moment it executes without error, and never retries an already-marked
-- file. If we silently skipped (the same "if exists" guard 0000_identity_
-- core.sql uses for its own grants) when app_user is missing -- e.g. an
-- operator runs `identity:db:migrate` before `db:migrate` has ever created
-- the role on a brand-new database -- this file would be marked applied
-- forever having revoked nothing, and the next (correctly-ordered) business
-- migration's blanket grant would permanently widen user/account/
-- verification with no later re-assertion to narrow them back down. Raising
-- here instead makes identity:db:migrate fail the whole run, so the file is
-- NOT recorded as applied and will be retried the next time it's run (after
-- app_user actually exists) -- see this file's header comment for the full
-- two-pipeline ordering caveat.
-- ============================================================================

do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'app_user') then
    raise exception
      'app_user role does not exist yet -- run the business migrations '
      '(npm run db:migrate) before identity:db:migrate so this revoke '
      'actually takes effect instead of being silently skipped';
  end if;

  -- user: no account-deletion flow is wired in auth.ts -- see
  -- 0000_identity_core.sql for the full per-table rationale.
  revoke delete on "user" from app_user;

  -- account: no unlink-provider/account-deletion flow is wired.
  revoke delete on "account" from app_user;

  -- verification: tokens are issued once and consumed once (insert then
  -- delete), never mutated in place.
  revoke update on "verification" from app_user;

  -- session and rate_limit intentionally keep full SELECT/INSERT/UPDATE/
  -- DELETE -- sign-in/sign-out/session-rotation and rate-limit bucket
  -- pruning genuinely need all four operations (see 0000_identity_core.sql).
end $$;
