-- ============================================================================
-- Hand-written migration: fix-round #6 findings from security-reviewer's
-- exhaustive 35-policy sweep, VERIFIED BY ACTUAL EXECUTION against a
-- disposable Postgres container.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0007. Idempotent (DROP POLICY/TRIGGER IF EXISTS + CREATE), so
-- re-running this file is safe.
--
-- Findings fixed here:
--
--   H-I — BLOCKING. `invitations_delete` (defined in 0001, never touched
--         since) had no owner-row guard, unlike `memberships_delete` (0004)
--         and the other invitations policies (0006/0007). Reproduced: a
--         `manager` cannot UPDATE status = 'revoked' on the owner's own
--         invitation (correctly blocked by 0007's invitations_update owner
--         guard), but COULD hard-delete that same row outright --
--           delete from invitations where token_hash = 'tok_owner_inv';
--         succeeded for a manager before this fix, because the pre-0008
--         `invitations_delete` policy (`tenant_access(structure_id) and
--         has_role_in_current_structure(array['owner','manager'])`) checked
--         nothing about the row's `role`. Asymmetric and wrong: the weaker
--         action (revoke) was guarded, the destructive one (delete) wasn't
--         -- a manager could simply delete-and-recreate to route around the
--         revoke guard entirely.
--
--         Fixed by adding the same owner-escalation guard already applied
--         to invitations_update/insert (0006/0007) and memberships_delete
--         (0004): `role <> 'owner' or
--         has_role_in_current_structure(array['owner'])`. A manager can
--         still delete invitations for non-owner roles they manage; only an
--         owner can delete an owner-role invitation.
--
--   M-B — Medium, same table/family. `invitations.status` and `expires_at`
--         had no state machine: 0007's `invitations_immutable_fields_guard()`
--         trigger only froze `invited_by/email/token_hash/role/structure_id`,
--         leaving `status` and `expires_at` freely mutable with no
--         transition rules. Reproduced: owner sets status = 'revoked', then
--         a manager sets status = 'pending' on the SAME row (token_hash
--         unchanged) -- the original invitation link becomes valid again;
--         a manager could also push `expires_at` on an expired/revoked row
--         far into the future to resurrect it; a manager could set
--         status = 'accepted' directly, with no membership ever created,
--         faking a completed acceptance.
--
--         Fixed in two parts:
--           1. `expires_at` becomes immutable on UPDATE, same mechanism and
--              same trigger as the existing frozen columns. There is no
--              legitimate business flow that extends or shortens an
--              invitation's expiry after the fact: an expired/revoked
--              invitation is re-issued via revoke-and-recreate on the
--              already-guarded INSERT path (0006), which naturally gets a
--              fresh `expires_at`. Defaulting to fully immutable (rather
--              than "may only shorten") avoids having to reason about a
--              monotonic-decrease edge case with no current caller.
--           2. The trigger gains an explicit status state machine:
--              `pending` is the only non-terminal status; `accepted`,
--              `revoked` and `expired` are terminal (per the actual
--              `invitation_status` enum: pending/accepted/revoked/expired).
--              Once a row's OLD.status is terminal, ANY further change to
--              `status` is rejected -- including setting it back to the
--              SAME terminal value is a no-op (not distinct, so it isn't
--              even evaluated) but moving to a DIFFERENT value, terminal or
--              not, raises. The only transitions allowed are
--              pending -> accepted / pending -> revoked / pending ->
--              expired (and pending -> pending, i.e. no real change). This
--              closes both the "un-revoke" and the "resurrect expired" path,
--              and also blocks a manager from forging `status = 'accepted'`
--              out of a non-pending row; forging it directly out of
--              `pending` is still technically possible at the DB layer (no
--              app-level acceptance flow exists yet to call this a
--              regression against), but is flagged below for the app layer
--              to close when the real acceptance flow lands.
--
-- ----------------------------------------------------------------------------
-- 0. Self-test prerequisite: fail loudly if 0001/0006/0007 are not already
--    applied (this migration edits objects they create).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.has_role_in_current_structure(text[])') is null then
    raise exception '0008 requires 0001_tenancy_rls_audit.sql to be applied first';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'invitations' and policyname = 'invitations_delete'
  ) then
    raise exception '0008 requires 0001_tenancy_rls_audit.sql (invitations_delete) to be applied first';
  end if;

  if to_regprocedure('public.invitations_immutable_fields_guard()') is null then
    raise exception '0008 requires 0007_invitations_update_select_guard.sql to be applied first';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. H-I — invitations_delete: add the owner-escalation guard, mirroring
--    memberships_delete (0004) and invitations_update/insert (0006/0007).
-- ----------------------------------------------------------------------------
drop policy if exists invitations_delete on invitations;
create policy invitations_delete on invitations
  for delete using (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  );

-- ----------------------------------------------------------------------------
-- 2. M-B — extend invitations_immutable_fields_guard(): freeze expires_at
--    and enforce the status state machine (pending is the only
--    non-terminal status; accepted/revoked/expired are terminal and cannot
--    transition to anything else).
--
--    Replaces the 0007 version of this function in place; the trigger
--    itself (trg_invitations_immutable) is unchanged and does not need to
--    be re-created, but we re-create it anyway (idempotent DROP/CREATE) so
--    this file stands on its own if ever replayed out of order against a
--    partially-applied schema.
-- ----------------------------------------------------------------------------
create or replace function invitations_immutable_fields_guard()
returns trigger
language plpgsql
as $$
begin
  -- Attribution / targeting / identity columns: immutable since 0007.
  if new.invited_by is distinct from old.invited_by
     or new.email      is distinct from old.email
     or new.token_hash is distinct from old.token_hash
     or new.role       is distinct from old.role
     or new.structure_id is distinct from old.structure_id then
    raise exception 'invitations: only status may be updated (revoke and re-create instead)';
  end if;

  -- M-B: expires_at is now immutable too. Re-issuing an invitation (new
  -- expiry included) goes through revoke-and-recreate on the INSERT path.
  if new.expires_at is distinct from old.expires_at then
    raise exception 'invitations: expires_at is immutable (revoke and re-create instead)';
  end if;

  -- M-B: status state machine. pending is the only status that may change
  -- into something else; accepted/revoked/expired are terminal.
  if new.status is distinct from old.status and old.status <> 'pending' then
    raise exception 'invitations: status % is terminal and cannot transition to % (revoke and re-create instead)',
      old.status, new.status;
  end if;

  return new;
end
$$;

drop trigger if exists trg_invitations_immutable on invitations;
create trigger trg_invitations_immutable before update on invitations
  for each row execute function invitations_immutable_fields_guard();

-- Not directly callable by app_user; it only ever runs as a trigger (same
-- rationale as 0007 -- TRIGGER privilege on the table is what's required,
-- not EXECUTE on the function). Explicitly revoked from PUBLIC again since
-- `create or replace function` does not preserve prior REVOKEs.
revoke execute on function invitations_immutable_fields_guard() from public;

-- ----------------------------------------------------------------------------
-- 3. Validation performed (see also db/README.md "Fix-round #6" section):
--    full chain 0000->0008 (business) + identity 0000->0001, superuser
--    (Supabase-style BYPASSRLS) migrator config only, against a disposable
--    postgres:16-alpine container.
--
--    H-I exploit scenario:
--      a) manager DELETE on the owner's invitation (role = 'owner') ->
--         blocked ("new row violates row-level security policy" is not the
--         right error for DELETE; actual error is 0 rows affected / RLS
--         USING clause excludes the row -- confirmed via
--         `select ... for update` probe that the row is invisible to the
--         manager's DELETE USING clause while still visible to the
--         manager's SELECT, i.e. the delete is correctly blocked and not a
--         silent 0-row no-op masking a different bug).
--      b) owner DELETE on their own (or another owner's) invitation ->
--         still works, confirming not over-blocked.
--      c) manager DELETE on a non-owner-role invitation they created ->
--         still works, confirming not over-blocked.
--
--    M-B state-machine scenario:
--      d) owner sets status = 'revoked'; manager then attempts
--         status = 'pending' on the SAME row -> blocked by the trigger
--         ("invitations: status revoked is terminal and cannot transition
--         to pending").
--      e) manager attempts to extend expires_at on an existing row (any
--         status) -> blocked by the trigger ("invitations: expires_at is
--         immutable").
--      f) owner/manager can still set status = 'revoked' once from
--         'pending' -> succeeds. status = 'accepted' from 'pending' also
--         still succeeds (no app-layer caller exists yet, but the
--         transition is not permanently sealed off at the DB layer for
--         when the real acceptance flow lands). Once either terminal state
--         is reached, no further status change is possible without
--         revoke-and-recreate via the guarded INSERT path.
--
--    Full prior exploit suite re-run with zero regression, using the
--    security-reviewer's exhaustive 4-verbs-times-all-tenant-tables sweep
--    as the checklist (not just the historical finding list): C1, C2, H2,
--    H3, H-A, H-D, H-E, H-F, H-H, M-A, owner-lockout, M1. DELETE on
--    `memberships` re-verified unchanged (0004's owner guard still holds).
--    DELETE on `structures` re-verified: no policy exists for that
--    command on that table, and RLS defaults to deny when no policy
--    matches the command being executed -- confirmed by execution that
--    `delete from structures ...` returns 0 rows affected for every role
--    tested (owner included), i.e. correctly unreachable, not accidentally
--    allowed.
-- ============================================================================
