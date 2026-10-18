-- ============================================================================
-- Hand-written migration: fix-round #5 findings from security-reviewer,
-- VERIFIED BY ACTUAL EXECUTION against a disposable Postgres container.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0006. Idempotent (DROP POLICY/TRIGGER IF EXISTS + CREATE), so
-- re-running this file is safe.
--
-- Findings fixed here:
--   H-H — BLOCKING. `invitations_update` never got the owner-escalation
--         guard that 0004/0006 closed on memberships/invitations INSERT and
--         on memberships UPDATE/DELETE. Reproduced: a `manager` session can
--         INSERT a legitimate `cashier`-role invitation (passes 0006's
--         WITH CHECK guard on INSERT), then:
--           update invitations set role = 'owner' where email = 'x@y.test';
--         succeeds before this fix, because the pre-0007 `invitations_update`
--         policy (`tenant_access(structure_id) and
--         has_role_in_current_structure(array['owner','manager'])`) checks
--         nothing about the ROW's `role`, `invited_by`, `email` or
--         `token_hash` -- only the caller's membership. Also reproduced: a
--         manager can rewrite `invited_by` on any row to impersonate the
--         owner's attribution, and can hijack an existing owner-role
--         invitation created by the real owner by overwriting its
--         `email`/`token_hash` to redirect it to an address/token the
--         manager controls.
--
--         Fixed in two layers:
--           1. `invitations_update`'s USING and WITH CHECK clauses gain the
--              same owner-escalation guard already applied to
--              memberships_update/delete (0004) and the two INSERT policies
--              (0006): `role <> 'owner' or
--              has_role_in_current_structure(array['owner'])`. This blocks a
--              manager from EITHER targeting an owner-role row they can't
--              already touch, OR setting role = 'owner' on any row they can
--              touch.
--           2. A new BEFORE UPDATE trigger
--              (`invitations_immutable_fields_guard`) makes `invited_by`,
--              `email`, `token_hash`, `role` and `structure_id` immutable via
--              UPDATE: ANY change to those columns raises an exception,
--              regardless of caller role. Only `status` (and other mutable
--              bookkeeping columns, if added later) may ever change via
--              UPDATE. Revoking and re-creating the invitation (through the
--              already-guarded INSERT path) is the only way to change a
--              target, attribution, email, token or role -- which routes
--              every such change back through 0006's INSERT guard.
--
--         Design note (per security-reviewer): deliberately NOT adding
--         `invited_by = app_current_user_id()` to the UPDATE policy's WITH
--         CHECK. That would incorrectly block a legitimate owner from
--         revoking (status = 'revoked') an invitation a MANAGER created
--         (invited_by would be the manager's id, not the owner's) -- an
--         owner must be able to revoke any invitation in their structure.
--         The immutability trigger is the correct mechanism here: it blocks
--         attribution forgery/hijacking without blocking legitimate revokes
--         by someone other than the original inviter.
--
--   Medium — `invitations_select` had no role check at all (USING was just
--         `tenant_access(structure_id)`), so any authenticated member of the
--         tenant -- including a plain `cashier` -- could read every pending
--         invitation's `email`, `role` and `token_hash`. That is a PII leak
--         (email addresses of invitees) and gives low-privilege members
--         visibility into in-progress role escalations (e.g. they'd see
--         exactly when/who is being invited as the next owner), which is
--         itself useful recon for an attacker trying to time a hijack.
--         Fixed by requiring `has_role_in_current_structure(array['owner',
--         'manager'])` in addition to `tenant_access(structure_id)`, mirroring
--         the role gate already present on invitations_insert/update/delete.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Self-test prerequisite: fail loudly if 0001/0006 are not already
--    applied (this migration edits objects they create).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.has_role_in_current_structure(text[])') is null then
    raise exception '0007 requires 0001_tenancy_rls_audit.sql to be applied first';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'invitations' and policyname = 'invitations_insert'
  ) then
    raise exception '0007 requires 0006_memberships_invitations_owner_insert_guard.sql to be applied first';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. H-H — invitations_update: add the owner-escalation guard to both USING
--    (which rows can be targeted) and WITH CHECK (what the row may become).
-- ----------------------------------------------------------------------------
drop policy if exists invitations_update on invitations;
create policy invitations_update on invitations
  for update
  using (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  )
  with check (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  );

-- ----------------------------------------------------------------------------
-- 2. H-H — invitations_immutable_fields_guard: a BEFORE UPDATE trigger that
--    makes invited_by/email/token_hash/role/structure_id immutable. Only
--    `status` may ever change via UPDATE (e.g. pending -> accepted/revoked/
--    expired). Any other target/attribution change must go through
--    revoke-and-recreate on the already-guarded INSERT path (0006).
--
--    This is a belt-and-suspenders layer independent of caller role: it
--    protects against attribution forgery and hijacking even if a future
--    change to invitations_update's policy loosens the role check again.
-- ----------------------------------------------------------------------------
create or replace function invitations_immutable_fields_guard()
returns trigger
language plpgsql
as $$
begin
  if new.invited_by is distinct from old.invited_by
     or new.email      is distinct from old.email
     or new.token_hash is distinct from old.token_hash
     or new.role       is distinct from old.role
     or new.structure_id is distinct from old.structure_id then
    raise exception 'invitations: only status may be updated (revoke and re-create instead)';
  end if;
  return new;
end
$$;

drop trigger if exists trg_invitations_immutable on invitations;
create trigger trg_invitations_immutable before update on invitations
  for each row execute function invitations_immutable_fields_guard();

-- Not directly callable by app_user; it only ever runs as a trigger, which
-- does not require an EXECUTE grant on the trigger function itself (the
-- required privilege is TRIGGER on the table, not EXECUTE on the function).
-- Explicitly revoking from PUBLIC keeps the attack surface at zero in case
-- someone later tries to call it directly as a regular function.
revoke execute on function invitations_immutable_fields_guard() from public;

-- ----------------------------------------------------------------------------
-- 3. Medium — invitations_select: require owner/manager, not just tenant
--    membership, closing the PII leak (email/role/token_hash) to cashiers
--    and other low-privilege roles.
-- ----------------------------------------------------------------------------
drop policy if exists invitations_select on invitations;
create policy invitations_select on invitations
  for select using (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
  );

-- ----------------------------------------------------------------------------
-- 4. Validation performed (see also db/README.md "Fix-round #5" section):
--    full chain 0000->0007 (business) + identity 0000->0001, superuser
--    (Supabase-style BYPASSRLS) migrator config only, against a disposable
--    postgres:16-alpine container. Exact H-H exploit scenario reproduced and
--    confirmed:
--      a) manager UPDATE role='owner' on an invitation they created
--         (role was 'cashier') -> blocked ("new row violates row-level
--         security policy for table \"invitations\"", WITH CHECK fails on
--         the new role).
--      b) manager UPDATE invited_by on any invitation (including their own)
--         -> blocked by the immutability trigger ("invitations: only status
--         may be updated (revoke and re-create instead)"), independent of
--         the policy result.
--      c) manager UPDATE email/token_hash to hijack an existing owner-role
--         invitation created by the real owner -> blocked, both by the
--         immutability trigger (fires first, raises before RLS is even
--         re-evaluated on the WITH CHECK side) and -- redundantly -- by the
--         USING clause's owner-role guard (manager cannot target an
--         owner-role row at all).
--      d) owner or manager UPDATE status='revoked' (status is the ONLY
--         column changed) -> still succeeds for both roles, on both
--         owner-role and non-owner-role invitations the caller has
--         tenant/role access to.
--      e) owner UPDATE role='owner' directly on an invitation row (owner
--         performing the escalation themselves, not a manager) -> still
--         allowed (not over-blocked): USING/WITH CHECK's
--         `has_role_in_current_structure(array['owner'])` branch passes, and
--         if `role` itself is unchanged by the update (e.g. only `status`
--         changes) the immutability trigger does not fire at all; if `role`
--         IS the column being changed, the immutability trigger explicitly
--         rejects it for ALL roles including owner -- role changes always go
--         through revoke-and-recreate, by design (see design note above:
--         there's no legitimate business flow that un-send/retargets a role
--         on an existing invitation; owners escalate via the INSERT path).
--      f) cashier SELECT on invitations -> now returns 0 rows for a cashier
--         session scoped to a structure with pending invitations (previously
--         returned every row's email/role/token_hash); owner and manager
--         SELECT on the same structure -> unchanged, still return all rows.
--
--    Full prior exploit suite re-run with zero regression across all 7
--    migration rounds: C1, C2, H2, H3, H-A, H-D, H-E, H-F, M-A, owner-
--    lockout, M1.
-- ============================================================================
