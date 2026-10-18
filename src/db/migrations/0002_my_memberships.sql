-- ============================================================================
-- Additive migration (frontend-next scaffold, on top of the db-supabase
-- agent's 0000/0001): one small SECURITY DEFINER helper to make the
-- "which structures am I a member of" post-login flow possible at all under
-- the existing RLS policies.
--
-- Why this is needed: `memberships_select` (0001_tenancy_rls_audit.sql) is
-- `tenant_access(structure_id)`, which requires `structure_id =
-- app_current_structure_id()` -- i.e. the caller must ALREADY know which
-- structure to ask about. That's correct for every ordinary tenant-scoped
-- read, but it leaves no RLS-safe way for a freshly authenticated user (who
-- has a session but no `app.structure_id` GUC set yet) to discover which
-- structure(s) they belong to in order to pick one and navigate there.
--
-- `my_memberships()` closes that gap the same way the existing
-- `is_member_of_current_structure`/`has_role_in_current_structure` helpers
-- do: SECURITY DEFINER, but filtered strictly by `app_current_user_id()`
-- (set from the authenticated session server-side, never client input), so
-- it can only ever return the CALLER'S OWN membership rows -- it does not
-- bypass tenant isolation for anyone else's data, it just lifts the
-- structure_id-must-already-be-known requirement for the caller's own rows.
--
-- Idempotent (CREATE OR REPLACE / GRANT), same convention as 0001.
-- Flagged for security-reviewer: this is new DB surface added by the
-- frontend-next scaffold, not by db-supabase -- please re-review alongside
-- the rest of 0001's SECURITY DEFINER functions.
-- ============================================================================

create or replace function my_memberships()
returns table (structure_id uuid, role membership_role, structure_name text)
language sql
stable
security definer
set search_path = public
as $$
  select m.structure_id, m.role, s.name as structure_name
  from memberships m
  join structures s on s.id = m.structure_id
  where m.user_id = app_current_user_id()
    and m.status = 'active'
$$;

grant execute on function my_memberships() to app_user;
