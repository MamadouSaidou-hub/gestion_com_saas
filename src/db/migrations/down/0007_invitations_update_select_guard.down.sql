-- ============================================================================
-- MANUAL rollback for 0007_invitations_update_select_guard.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0007. Restores the exact pre-0007 policy
-- definitions (0001's invitations_select / invitations_update) and drops the
-- immutability trigger + its function.
--
-- WARNING: this REINTRODUCES H-H -- a `manager` can again UPDATE any
-- invitation's `role` to 'owner', rewrite `invited_by` to forge attribution,
-- and overwrite `email`/`token_hash` to hijack an existing invitation. It
-- also REINTRODUCES the Medium PII leak -- any tenant member (including a
-- `cashier`) can again SELECT every pending invitation's email/role/
-- token_hash. Only run this during development, never against a
-- tenant-carrying environment.
-- ============================================================================

drop trigger if exists trg_invitations_immutable on invitations;
drop function if exists invitations_immutable_fields_guard();

drop policy if exists invitations_update on invitations;
create policy invitations_update on invitations
  for update
  using ( tenant_access(structure_id) and has_role_in_current_structure(array['owner', 'manager']) )
  with check ( tenant_access(structure_id) and has_role_in_current_structure(array['owner', 'manager']) );

drop policy if exists invitations_select on invitations;
create policy invitations_select on invitations
  for select using ( tenant_access(structure_id) );

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
