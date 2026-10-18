-- ============================================================================
-- MANUAL rollback for 0000_initial_schema.sql.
--
-- Apply 0001's down script FIRST (it drops the RLS policies, triggers and
-- functions that reference these tables) before running this one, or the
-- DROP TABLE statements below will fail on dependent objects.
--
-- Drops tables in reverse dependency order (children before parents).
-- ============================================================================

drop table if exists audit_log;
drop table if exists payment_allocations;
drop table if exists payments;
drop table if exists invoices;
drop table if exists document_counters;
drop table if exists tax_settings;
drop table if exists sale_lines;
drop table if exists sales;
drop table if exists stock_movements;
drop table if exists stock_levels;
drop table if exists products;
drop table if exists product_categories;
drop table if exists warehouses;
drop table if exists suppliers;
drop table if exists units;
drop table if exists customers;
drop table if exists invitations;
drop table if exists memberships;
drop table if exists structures;
drop table if exists currencies;

drop type if exists invoice_status;
drop type if exists document_type;
drop type if exists sale_status;
drop type if exists stock_direction;
drop type if exists valuation_method;
drop type if exists membership_status;
drop type if exists membership_role;
drop type if exists invitation_status;

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
