-- ============================================================================
-- Hand-written migration: fixes for the security-reviewer's follow-up
-- Blocking/High findings against 0003_tighten_rls_audit_security.sql,
-- VERIFIED BY ACTUAL EXECUTION in both a BYPASSRLS and a non-BYPASSRLS
-- migrator config.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001/0002/0003. Idempotent (CREATE OR REPLACE / DROP POLICY IF EXISTS +
-- CREATE / DO $$ guards), so re-running this file is safe.
--
-- Findings fixed here:
--   H-A — a `manager` could demote/delete an EXISTING `owner` row as long as
--         another owner remained (memberships_update/memberships_delete only
--         blocked acting on your OWN row and promoting TO owner, not
--         touching a row that already IS owner).
--   H-C — FORCE ROW LEVEL SECURITY on `structures`/`memberships` made the
--         SECURITY DEFINER helpers recurse (is_member_of_current_structure ->
--         gated SELECT -> itself) and blocked create_structure_with_owner's
--         own INSERT outright, UNLESS the migrator role has BYPASSRLS. This
--         was a hard crash on every tenant query, not a graceful
--         fail-closed, for any migrator lacking BYPASSRLS.
--   C2 follow-up — PUBLIC-EXECUTE was revoked per-function in 0003, but the
--         next function anyone creates reverts to PostgreSQL's PUBLIC-
--         executable default. Added a default-privilege REVOKE so future
--         functions are safe by default.
--   pgcrypto in `public` — installed with EXECUTE granted to PUBLIC on
--         crypt/gen_salt/digest/hmac/pgp_* via the schema's default grants,
--         reopening the PostgREST/Data-API surface C2 closed. Moved to a
--         dedicated `extensions` schema (Supabase convention), EXECUTE
--         revoked from PUBLIC there too.
--   Schema-wide table default-privilege — 0001's
--         `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... ON TABLES TO
--         app_user` applies to EVERY future table in `public`, including
--         ones owned by a different domain (Better Auth's identity tables),
--         which is exactly why `src/modules/identity/migrations/
--         0001_tighten_grants.sql` had to claw privileges back by hand.
--         Revoked the default here so future tables get no implicit grant;
--         each new business-table migration must now GRANT app_user
--         explicitly (fail-closed by default, deliberate opt-in instead of
--         a schema-wide standing grant).
--
-- Still open (flagged, not built here, per the instruction not to build an
-- OTP/step-up flow without a provider wired -- see D5):
--   No step-up/OTP requirement exists yet for role changes (owner/manager
--   promoting or demoting a membership). RLS + the app layer's per-operation
--   authz are today's only gate on that action. Flag again for
--   security-reviewer / architect before this ships to a real client.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Self-test prerequisites: fail loudly, not silently, if 0001/0003 are not
--    already applied (this migration edits objects they create).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.create_structure_with_owner(text, text, text, text, valuation_method)') is null then
    raise exception '0004 requires 0003_tighten_rls_audit_security.sql to be applied first';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. H-C (mandatory part) — fail the migration loudly, with the offending
--    role name, if the migrator lacks BYPASSRLS.
--
--    NOTE on scope: this migration also removes FORCE ROW LEVEL SECURITY
--    from `structures`/`memberships` below (section 2), which removes THEIR
--    specific dependency on BYPASSRLS (a table owner without FORCE bypasses
--    RLS on its own tables natively, BYPASSRLS or not). This assertion stays
--    mandatory regardless, because:
--      a) `audit_log` and every table in the 0001 section-8 tenant_tables
--         loop (customers, products, sales, invoices, ...) KEEP FORCE ROW
--         LEVEL SECURITY -- out of scope for this fix, reviewer asked only
--         about structures/memberships -- and audit_log_before_insert() /
--         audit_log_verify() are SECURITY DEFINER functions that read
--         audit_log across role visibility, so they still need the
--         function-owner role to carry BYPASSRLS or they will themselves
--         under-return/recurse the same way.
--      b) It is a correctness invariant worth asserting at migration time
--         independent of today's specific FORCE/NO FORCE layout, so a future
--         migration that re-adds FORCE to structures/memberships (or moves
--         these functions to a non-owner role) fails loudly here instead of
--         crashing mysteriously at runtime on every tenant query.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bypassrls boolean;
begin
  select rolbypassrls into v_bypassrls from pg_roles where rolname = current_user;

  if not coalesce(v_bypassrls, false) then
    raise exception
      '0004: migrator role "%" does not have BYPASSRLS. SECURITY DEFINER '
      'functions that read FORCE-RLS tables (audit_log_before_insert, '
      'audit_log_verify, and -- before this migration''s NO FORCE change -- '
      'is_member_of_current_structure/create_structure_with_owner) depend on '
      'the owning role bypassing RLS, or they recurse/under-return/block '
      'writes at runtime instead of failing here. Grant it out-of-band as a '
      'superuser: ALTER ROLE % BYPASSRLS; (On Supabase, the project owner '
      'role already has this.) See db/README.md.',
      current_user, current_user;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. H-C (recommended part) — drop FORCE ROW LEVEL SECURITY on structures
--    and memberships specifically. RLS stays ENABLED (non-owner roles, i.e.
--    app_user, are still fully policy-gated); only the table OWNER (the
--    migrator role that also owns every SECURITY DEFINER function reading
--    these two tables) stops being subject to its own policies.
--
--    Why this is safe: app_user owns no tables and has no DDL rights, so it
--    was never the target FORCE was protecting against on these two tables
--    -- FORCE only matters for defending against the table OWNER querying
--    directly, which only the migrator (schema owner) can do, and the
--    migrator is a trusted, non-app-facing role by design (D2). Removing
--    FORCE here is what breaks the is_member_of_current_structure ->
--    (self) recursion and the structures_insert `with check (false)` block
--    on create_structure_with_owner's own INSERT, at the root, instead of
--    papering over it by requiring BYPASSRLS everywhere.
--
--    FORCE intentionally STAYS on every other table (audit_log, invitations,
--    the section-8 tenant_tables loop) -- those still rely on the owning
--    role's BYPASSRLS, asserted above.
-- ----------------------------------------------------------------------------
alter table structures no force row level security;
alter table memberships no force row level security;

-- ----------------------------------------------------------------------------
-- 3. H-A — memberships_update / memberships_delete: a non-owner (manager)
--    must not be able to touch a row that currently IS an owner, full stop
--    -- not just their own row, and not just block PROMOTING to owner.
--    Added to the USING clause (evaluated against the EXISTING/OLD row):
--      role <> 'owner' or has_role_in_current_structure(array['owner'])
--    This blocks a manager from demoting/deleting ANY owner row, even one
--    that isn't the last owner, while still letting an owner manage another
--    owner's row (has_role_in_current_structure(['owner']) is true for them).
--    The WITH CHECK clause already blocked promotion TO owner by a
--    non-owner (0003); kept here unchanged for completeness since the
--    policy is fully replaced.
-- ----------------------------------------------------------------------------
drop policy if exists memberships_update on memberships;
create policy memberships_update on memberships
  for update
  using (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and user_id <> app_current_user_id()
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  )
  with check (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and user_id <> app_current_user_id()
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  );

drop policy if exists memberships_delete on memberships;
create policy memberships_delete on memberships
  for delete using (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and user_id <> app_current_user_id()
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  );

-- Owner-lockout trigger (0003) is untouched: still an independent, defense-
-- in-depth layer against leaving a structure with zero active owners.

-- ----------------------------------------------------------------------------
-- 4. C2 follow-up — default-deny EXECUTE on every FUTURE function created by
--    the migrator in schema public, so the next SECURITY DEFINER helper
--    anyone adds doesn't silently revert to PostgreSQL's PUBLIC-executable
--    default. Per-function REVOKEs (0003) remain necessary for functions
--    that already existed before this statement; this only changes the
--    default for ones created from now on.
-- ----------------------------------------------------------------------------
alter default privileges in schema public
  revoke execute on functions from public;

-- ----------------------------------------------------------------------------
-- 5. pgcrypto — move out of `public` into a dedicated `extensions` schema
--    (Supabase convention), and lock EXECUTE down there the same way C2
--    locked down public. Guarded: only move it if it isn't already there,
--    so re-running this file (or applying it after someone already moved it
--    by hand) doesn't error.
-- ----------------------------------------------------------------------------
create schema if not exists extensions;

do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto'
      and n.nspname <> 'extensions'
  ) then
    begin
      execute 'alter extension pgcrypto set schema extensions';
    exception
      when insufficient_privilege then
        -- pgcrypto is a "trusted" extension (installable by a non-superuser
        -- with CREATE on the target schema), but its C-language member
        -- functions are still owned by the bootstrap/superuser role, not by
        -- whoever ran CREATE EXTENSION -- confirmed by execution: a
        -- non-superuser migrator that legitimately created the extension
        -- still cannot ALTER EXTENSION ... SET SCHEMA it, because that
        -- requires owning every member object. On Supabase this is a
        -- non-issue: the project's `postgres`/owner role already owns these
        -- functions and runs this successfully (same role this migration
        -- otherwise depends on for BYPASSRLS, see assertion above). Fail
        -- loudly and name the fix instead of surfacing Postgres' generic
        -- "must be owner of function digest".
        raise exception
          '0004: migrator role "%" cannot relocate the pgcrypto extension '
          '(insufficient privilege on its member functions, even though it '
          'owns the extension itself). Run this migration as the Supabase '
          'project-owner "postgres" role (which already owns those '
          'functions), then re-run.', current_user;
    end;
  end if;
end $$;

-- Schema USAGE is harmless to leave public (it only gates name resolution,
-- not execution); the functions themselves are what must be locked down.
grant usage on schema extensions to public;
revoke execute on all functions in schema extensions from public;
alter default privileges in schema extensions
  revoke execute on functions from public;

-- digest() is called, unqualified, inside audit_log_before_insert() and
-- audit_log_verify() (both SECURITY DEFINER, `set search_path = public`).
-- Moving pgcrypto out of `public` means that unqualified call now resolves
-- to nothing unless `extensions` is also on those two functions' search
-- path. Re-point them (bodies unchanged from 0003) -- app_user still needs
-- no EXECUTE grant on digest() itself: it only ever reaches it transitively,
-- as the function owner, through these two SECURITY DEFINER functions.
create or replace function audit_log_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev bytea;
  v_seq  bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.structure_id::text, 0));

  select entry_hash, seq into v_prev, v_seq
  from audit_log
  where structure_id = new.structure_id
  order by id desc
  limit 1;

  if v_prev is null then
    v_prev := decode(repeat('00', 32), 'hex'); -- genesis, per tenant
    v_seq := 0;
  end if;

  new.created_at := coalesce(new.created_at, now());
  new.seq := v_seq + 1;
  new.prev_hash := v_prev;
  new.entry_hash := digest(
    v_prev
    || convert_to(new.structure_id::text, 'UTF8')
    || convert_to(coalesce(new.actor_id, ''), 'UTF8')
    || convert_to(new.action, 'UTF8')
    || convert_to(new.target_type, 'UTF8')
    || convert_to(coalesce(new.target_id::text, ''), 'UTF8')
    || convert_to(new.payload::text, 'UTF8')
    || convert_to(new.created_at::text, 'UTF8'),
    'sha256'
  );
  return new;
end;
$$;

create or replace function audit_log_verify(p_structure_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r          record;
  v_prev     bytea := decode(repeat('00', 32), 'hex');
  v_seq      bigint := 0;
  v_computed bytea;
begin
  if p_structure_id is distinct from app_current_structure_id() then
    raise exception 'audit_log_verify: structure_id % does not match session context', p_structure_id;
  end if;

  if not has_role_in_current_structure(array['owner', 'accountant', 'auditor']) then
    raise exception 'audit_log_verify: caller lacks a reader role on structure %', p_structure_id;
  end if;

  for r in
    select * from audit_log where structure_id = p_structure_id order by id asc
  loop
    v_seq := v_seq + 1;
    v_computed := digest(
      v_prev
      || convert_to(r.structure_id::text, 'UTF8')
      || convert_to(coalesce(r.actor_id, ''), 'UTF8')
      || convert_to(r.action, 'UTF8')
      || convert_to(r.target_type, 'UTF8')
      || convert_to(coalesce(r.target_id::text, ''), 'UTF8')
      || convert_to(r.payload::text, 'UTF8')
      || convert_to(r.created_at::text, 'UTF8'),
      'sha256'
    );

    if r.prev_hash <> v_prev or r.entry_hash <> v_computed or r.seq <> v_seq then
      return r.id;
    end if;

    v_prev := r.entry_hash;
  end loop;

  return null; -- intact
end;
$$;

-- These two functions were already revoked-from-PUBLIC/granted-to-app_user
-- by 0003; CREATE OR REPLACE does not reset grants, so no re-grant is
-- needed here. Listed again only for completeness of the audit trail:
--   revoke execute on function audit_log_before_insert() from public;  -- already done, 0003
--   revoke execute on function audit_log_verify(uuid) from public;     -- already done, 0003

-- ----------------------------------------------------------------------------
-- 6. Schema-wide table default-privilege narrowing. 0001 ran:
--      alter default privileges in schema public
--        grant select, insert, update, delete on tables to app_user;
--    which is not table-name-scoped -- Postgres' ALTER DEFAULT PRIVILEGES
--    grammar has no "FOR TABLES NAMED (...)" clause, it is schema-wide by
--    construction. That is what silently handed app_user full CRUD on
--    Better Auth's `user`/`account`/`verification` tables the moment they
--    were created (a SEPARATE migration pipeline, see
--    src/modules/identity/migrations/0001_tighten_grants.sql's long comment),
--    forcing a manual claw-back REVOKE there with no guarantee it runs in
--    the right order relative to this one.
--
--    Fix: REVOKE the default-privilege clause itself (metadata only --
--    does NOT touch privileges already granted on EXISTING tables, so every
--    current business table keeps the explicit, one-time grant 0001's
--    `grant ... on all tables in schema public to app_user;` already gave
--    it -- confirmed: that statement is not a "default privilege", it is an
--    ordinary GRANT evaluated once against tables that existed at the time,
--    unaffected by this REVOKE). From this migration onward, ANY new table
--    -- business or otherwise -- created in `public` gets NO app_user
--    privileges until its own migration explicitly grants them. This is a
--    deliberate trade: 0001's comment framed the old behavior as avoiding
--    "a missing GRANT that looks like a bug"; the reviewer's framing (and
--    the one adopted here) is that an explicit, auditable GRANT per new
--    business table is safer than a standing schema-wide default that any
--    future table -- including ones outside this domain -- silently
--    inherits. Document the new obligation for whoever adds the next
--    business table: add its own `grant select, insert, update, delete on
--    <table> to app_user;` alongside its RLS policies, in the same
--    migration that creates it.
--
--    Does NOT move business tables to a dedicated schema (the other option
--    the reviewer offered): ~15 existing tables, their RLS policies, FK
--    targets and app-layer SQL all reference `public.<table>` today: a
--    schema move is a large, separately-reviewable migration on its own,
--    out of scope for this fix-round. Revoking the default achieves the
--    same safety property (no silent over-grant to future tables) without
--    that blast radius.
--
--    Interaction with identity's 0001_tighten_grants.sql: that file's
--    REVOKEs (delete on "user"/"account", update on "verification") remain
--    in place and now become belt-and-suspenders rather than a correction
--    of a standing over-grant -- harmless to keep, since any future
--    identity table created AFTER this migration runs will not receive the
--    over-grant in the first place. Its "operational caveat" about pipeline
--    ordering is also narrowed: the risk it described was the business
--    pipeline's default-privilege clause re-widening grants after identity's
--    REVOKE ran; with the default-privilege clause gone (this migration),
--    there is nothing left to re-widen tables created after 0004 runs --
--    only still-ordering-sensitive for a database where identity's pipeline
--    runs between 0001 and this 0004 (i.e. before the default is revoked).
--    Flagging that narrow residual window for devops/db-supabase, not fixed
--    here (it's an operational sequencing concern, not a schema one).
-- ----------------------------------------------------------------------------
alter default privileges in schema public
  revoke select, insert, update, delete on tables from app_user;
alter default privileges in schema public
  revoke usage, select on sequences from app_user;
