-- Manual rollback for 0002_my_memberships.sql. Run with the migrator role.
drop function if exists my_memberships();

-- ----------------------------------------------------------------------------
-- Keep drizzle-kit's own bookkeeping (drizzle.__drizzle_migrations) in sync
-- with this rollback, or the next `migrate:all` will trust the journal over
-- the live schema and silently no-op. See db/README.md's "Rollback keeps
-- drizzle's own journal honest" section for the full why/how.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from drizzle.__drizzle_migrations) then
    raise exception 'drizzle.__drizzle_migrations is already empty -- down scripts were not run in strict reverse order, or this one already ran. Refusing to delete nothing silently.';
  end if;

  delete from drizzle.__drizzle_migrations
  where id = (select max(id) from drizzle.__drizzle_migrations);
end
$$;
