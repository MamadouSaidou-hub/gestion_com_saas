-- ============================================================================
-- MANUAL rollback for 0005_structures_crosstenant_grant_regrant_fix.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0005. Restores the exact pre-0005 definitions
-- from 0001_tenancy_rls_audit.sql / pre-0005 grant state.
--
-- WARNING: this REINTRODUCES H-D (cross-tenant SELECT/UPDATE on
-- `structures` from a session scoped to a different structure the caller
-- happens to also be a member of), removes the H-E terminal re-assertion
-- (identity tables can regain DELETE/UPDATE if the pipelines run in the
-- wrong order again), and restores M-A's no-op `IN SCHEMA` default-privilege
-- form (future functions revert to PUBLIC-executable by default). Only run
-- this during development, never against a tenant-carrying environment.
-- ============================================================================

-- --- 4. M-A: restore the (no-op) IN SCHEMA forms, drop the working global
--     form. This intentionally restores 0004's original (broken) intent for
--     rollback fidelity -- see 0004/0005 comments for why these are no-ops.
alter default privileges grant execute on functions to public;
alter default privileges in schema public
  revoke execute on functions from public;
alter default privileges in schema extensions
  revoke execute on functions from public;

-- --- 2. H-E: nothing to roll back structurally (REVOKE re-assertion only,
--     no object created) -- re-granting here would reopen the exact hole
--     this migration closes, so intentionally left as a no-op. If you need
--     to fully mirror pre-0005 grant state for a specific test, re-run:
--       grant delete on "user" to app_user;
--       grant delete on "account" to app_user;
--       grant update on "verification" to app_user;
--     by hand -- not done automatically here.

-- --- 1. H-D: restore 0001's original structures_select/structures_update --
drop policy if exists structures_select on structures;
create policy structures_select on structures
  for select using ( is_member_of_current_structure(id) );

drop policy if exists structures_update on structures;
create policy structures_update on structures
  for update
  using ( is_member_of_current_structure(id) and has_role_in_current_structure(array['owner']) )
  with check ( is_member_of_current_structure(id) and has_role_in_current_structure(array['owner']) );

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
