-- ============================================================================
-- Hand-written migration: fix-round #4 findings from security-reviewer,
-- VERIFIED BY ACTUAL EXECUTION against a disposable Postgres container.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0005. Idempotent (DROP POLICY IF EXISTS + CREATE), so re-running this
-- file is safe.
--
-- Findings fixed here:
--   H-F — BLOCKING. `memberships_insert` and `invitations_insert` never got
--         the owner-protection guard that `memberships_update`/
--         `memberships_delete` got in fix-round #3 (0004, H-A). Both
--         policies' WITH CHECK only required the caller to be an
--         owner/manager (via `can_bootstrap_or_manage_memberships` /
--         `has_role_in_current_structure(['owner','manager'])`), with no
--         check on the ROLE BEING INSERTED -- so a `manager` could INSERT a
--         brand-new row with `role = 'owner'` directly, fully bypassing the
--         H-A update/delete protections via an unpatched INSERT path.
--         Reproduced: as a `manager` session,
--           insert into memberships (user_id, structure_id, role, status)
--           values ('u9', '<S1>', 'owner', 'active');
--         succeeded before this fix. Same gap on `invitations_insert` -- a
--         manager could create a pending invitation whose target role is
--         `owner`, which would hand ownership to whoever accepts it.
--         Fixed by adding the same guard 0004 added to
--         memberships_update/memberships_delete's USING clause, this time to
--         the WITH CHECK clause (the NEW row) of both INSERT policies:
--           role <> 'owner' or has_role_in_current_structure(array['owner'])
--         A manager can still insert/invite any non-owner role; only an
--         existing owner can insert/invite a new owner. A legitimate owner
--         bootstrapping a brand-new structure via
--         `create_structure_with_owner()` is unaffected -- that function
--         is SECURITY DEFINER and its own INSERT is not subject to this (or
--         any) RLS policy at all, per 0004 section 2 (NO FORCE ROW LEVEL
--         SECURITY on `memberships`, migrator-owned role).
--
--   Medium — `invitations.invited_by` was caller-supplied with no check it
--         matched the session user (unlike `audit_log_append`, fixed for the
--         equivalent gap in 0003/C1), letting a manager create an invitation
--         attributed to someone else (e.g. the owner), forging attribution
--         on a sensitive action. Fixed by adding
--         `and invited_by = app_current_user_id()` to `invitations_insert`'s
--         WITH CHECK.
--
-- Not fixed here, judgment calls documented in db/README.md:
--   H-G — a non-superuser BYPASSRLS migrator role is NOT a supported
--         configuration (pgcrypto relocation in 0004 either fails outright,
--         or -- if pgcrypto was pre-created directly in `extensions` -- the
--         migration otherwise proceeds but the role boundary this project
--         relies on for BYPASSRLS/ownership assumptions is not the one this
--         repo is validated against). This project's migrator role MUST be
--         a Supabase-style owner role with effective superuser/BYPASSRLS
--         privileges (true by default for the `postgres` role on a Supabase
--         project). db/README.md updated to mark the previously-described
--         "supported alternative" as NOT SUPPORTED, per explicit user
--         decision -- no code change attempted here, see README section 2d.
--   Unlimited tenant creation (residual M9 debt) -- `create_structure_with_
--         owner()` still has no quota. Explicitly DEFERRED, not fixed, in
--         this migration: a per-account/per-plan tenant quota is an
--         application/billing-module concern (it needs a plan/subscription
--         model that does not exist yet in this schema), not a DB-RLS
--         concern -- adding an arbitrary hardcoded limit at the DB layer now
--         would need to be ripped out or hard-coded again once billing
--         exists. Tracked as accepted debt; revisit when a billing/plan
--         module is designed (architect + db-supabase).
--   `ALTER DEFAULT PRIVILEGES` (0005, M-A fix) has no `FOR ROLE` clause --
--         documented, not code-fixed, in db/README.md. Per Postgres
--         semantics, `ALTER DEFAULT PRIVILEGES` with no `FOR ROLE` clause
--         already implicitly applies "for objects created by the CURRENT
--         role" (there is no role-agnostic "for role" default to begin
--         with) -- adding an explicit `FOR ROLE <name>` would not change
--         this behavior, it would just hardcode today's migrator role name
--         into the migration. Given the H-G decision above (migrator role
--         is now a stable, Supabase-only "postgres"/project-owner role,
--         never a rotating/renamed non-superuser role), this residual
--         constraint is accepted and documented rather than coded around.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Self-test prerequisite: fail loudly if 0001/0004 are not already
--    applied (this migration edits objects they create).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.can_bootstrap_or_manage_memberships(uuid)') is null then
    raise exception '0006 requires 0001_tenancy_rls_audit.sql to be applied first';
  end if;

  if to_regprocedure('public.create_structure_with_owner(text, text, text, text, valuation_method)') is null then
    raise exception '0006 requires 0004_owner_lockdown_bypassrls_assert.sql to be applied first';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. H-F — memberships_insert: block inserting a new row with role = 'owner'
--    unless the caller already holds 'owner' in the current structure.
--    `can_bootstrap_or_manage_memberships(structure_id)` is unchanged (still
--    requires owner/manager, or the now-dead zero-members branch superseded
--    by create_structure_with_owner since 0003) -- this adds a SEPARATE check
--    on the role of the ROW BEING INSERTED (the NEW row, i.e. the WITH CHECK
--    side), exactly mirroring 0004's USING-side guard on UPDATE/DELETE.
-- ----------------------------------------------------------------------------
drop policy if exists memberships_insert on memberships;
create policy memberships_insert on memberships
  for insert with check (
    structure_id = app_current_structure_id()
    and can_bootstrap_or_manage_memberships(structure_id)
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  );

-- ----------------------------------------------------------------------------
-- 2. H-F (invitations) + Medium (invited_by forgery) — invitations_insert:
--    same owner-role guard on the NEW row's `role`, plus pin `invited_by` to
--    the real session user so a manager cannot attribute an invitation to
--    someone else (e.g. the owner).
-- ----------------------------------------------------------------------------
drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations
  for insert with check (
    structure_id = app_current_structure_id()
    and has_role_in_current_structure(array['owner', 'manager'])
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
    and invited_by = app_current_user_id()
  );

-- ----------------------------------------------------------------------------
-- 3. Validation performed (see also db/README.md "Fix-round #4" section):
--    full chain 0000->0006 (business) + identity 0000->0001, superuser
--    (Supabase-style BYPASSRLS) migrator config only, against a disposable
--    postgres:16-alpine container:
--      a) as a `manager` session scoped to S1:
--           insert into memberships (user_id, structure_id, role, status)
--           values ('u9', '<S1>', 'owner', 'active');
--         now fails with "new row violates row-level security policy for
--         table \"memberships\"" (previously succeeded).
--      b) as an `owner` session scoped to S1, the identical statement
--         (inserting a co-owner, e.g. 'u10') still SUCCEEDS.
--      c) as a `manager` session scoped to S1:
--           insert into invitations (structure_id, email, role, invited_by,
--             token_hash, expires_at)
--           values ('<S1>', 'x@y.test', 'owner', '<manager_user_id>',
--             'hash', now() + interval '1 day');
--         now fails the same way (previously succeeded).
--      d) as a `manager` session, inserting a non-owner-role invitation
--         (role = 'cashier') with `invited_by` set to a DIFFERENT user id
--         (e.g. the owner's) now fails ("new row violates row-level security
--         policy for table \"invitations\""); the identical statement with
--         `invited_by` set to the manager's OWN session user id succeeds.
--      e) `create_structure_with_owner()` (bootstrap path) unaffected:
--         creating a brand-new structure + first owner membership still
--         succeeds end-to-end (SECURITY DEFINER, NO FORCE RLS on
--         memberships per 0004 -- not subject to memberships_insert at all).
--    Full prior exploit suite (C1, C2, H2, H3, H-A, H-D, H-E, M-A,
--    owner-lockout, M1) re-run with zero regression.
-- ============================================================================
