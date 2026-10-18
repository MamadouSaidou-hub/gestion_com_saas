-- ============================================================================
-- MANUAL rollback for 0008_invitations_delete_guard_status_machine.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0008. Restores the exact pre-0008 policy
-- definition (0001's invitations_delete) and the exact pre-0008 version of
-- invitations_immutable_fields_guard() (0007's: only invited_by/email/
-- token_hash/role/structure_id frozen, no expires_at freeze, no status
-- state machine).
--
-- WARNING: this REINTRODUCES H-I -- a manager can again hard-DELETE an
-- owner-role invitation (routing around the invitations_update owner
-- guard entirely by deleting-and-recreating instead of updating). It also
-- REINTRODUCES M-B -- status becomes freely mutable again (a manager can
-- un-revoke an owner's revocation, resurrect an expired invitation, or
-- fake status = 'accepted' with no membership created), and expires_at
-- becomes freely mutable again (a manager can extend an expired/revoked
-- invitation's lifetime). Only run this during development, never against
-- a tenant-carrying environment.
-- ============================================================================

drop trigger if exists trg_invitations_immutable on invitations;
drop function if exists invitations_immutable_fields_guard();

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

revoke execute on function invitations_immutable_fields_guard() from public;

create trigger trg_invitations_immutable before update on invitations
  for each row execute function invitations_immutable_fields_guard();

drop policy if exists invitations_delete on invitations;
create policy invitations_delete on invitations
  for delete using ( tenant_access(structure_id) and has_role_in_current_structure(array['owner', 'manager']) );

-- ----------------------------------------------------------------------------
-- Keep drizzle-kit's own bookkeeping (drizzle.__drizzle_migrations) in sync
-- with this rollback, or the next `migrate:all` will trust the journal over
-- the live schema and silently no-op. See db/README.md's "Rollback keeps
-- drizzle's own journal honest" section for the full why/how.
-- ----------------------------------------------------------------------------
do $cleanup$
begin
  if not exists (select 1 from drizzle.__drizzle_migrations) then
    raise exception 'drizzle.__drizzle_migrations is already empty -- down scripts were not run in strict reverse order, or this one already ran. Refusing to delete nothing silently.';
  end if;

  delete from drizzle.__drizzle_migrations
  where id = (select max(id) from drizzle.__drizzle_migrations);
end
$cleanup$;
