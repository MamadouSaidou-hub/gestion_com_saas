-- ============================================================================
-- MANUAL rollback for 0010_sales_payment_linkage.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically. Run it by hand with the MIGRATOR role to undo 0010.
--
-- WARNING: destructive for any data already populated against these two
-- columns (payments.sale_id, sales.paid_minor) -- only run during
-- development, never against a tenant-carrying environment with real
-- sales/payments already using them.
-- ============================================================================

alter table sales drop constraint if exists sales_paid_le_total_chk;
alter table sales drop column if exists paid_minor;

drop index if exists payments_structure_sale_idx;
alter table payments drop constraint if exists payments_sale_fk;
alter table payments drop column if exists sale_id;

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
