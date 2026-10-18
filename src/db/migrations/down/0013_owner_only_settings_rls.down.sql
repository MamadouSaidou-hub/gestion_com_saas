-- Manual rollback for 0013_owner_only_settings_rls.sql.
drop policy if exists structure_settings_select on structure_settings;
drop policy if exists structure_settings_owner_write on structure_settings;
drop policy if exists structure_settings_owner_update on structure_settings;
drop policy if exists structure_settings_owner_delete on structure_settings;
create policy structure_settings_tenant_isolation on structure_settings
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

drop policy if exists tax_settings_select on tax_settings;
drop policy if exists tax_settings_owner_write on tax_settings;
drop policy if exists tax_settings_owner_update on tax_settings;
drop policy if exists tax_settings_owner_delete on tax_settings;
create policy tax_settings_tenant_isolation on tax_settings
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

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
