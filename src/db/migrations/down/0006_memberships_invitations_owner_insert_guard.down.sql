-- ============================================================================
-- MANUAL rollback for 0006_memberships_invitations_owner_insert_guard.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0006. Restores the exact pre-0006 policy
-- definitions (0001's memberships_insert / invitations_insert).
--
-- WARNING: this REINTRODUCES H-F -- a `manager` can again INSERT a new
-- `owner` membership row directly, and create an `owner`-role invitation
-- attributed to an arbitrary `invited_by` value. Only run this during
-- development, never against a tenant-carrying environment.
-- ============================================================================

drop policy if exists memberships_insert on memberships;
create policy memberships_insert on memberships
  for insert with check (
    structure_id = app_current_structure_id()
    and can_bootstrap_or_manage_memberships(structure_id)
  );

drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations
  for insert with check (
    structure_id = app_current_structure_id()
    and has_role_in_current_structure(array['owner', 'manager'])
  );

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
