-- ============================================================================
-- MANUAL rollback for 0015_supplier_purchasing.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0015.
--
-- WARNING: destructive for any data populated against 0015's new tables --
-- it DROPs supplier_deliveries/supplier_delivery_lines/supplier_payments/
-- supplier_payment_allocations outright. The 'delivery' value added to the
-- `document_type` enum (section 1) is NOT removed here, same reason 0009's
-- and 0014's down scripts leave their own added enum values in place:
-- PostgreSQL has no `ALTER TYPE ... DROP VALUE`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 9 (reverse). Grants.
-- ----------------------------------------------------------------------------
revoke select, insert, update, delete on supplier_payment_allocations from app_user;
revoke select, insert, update, delete on supplier_payments from app_user;
revoke select, insert, update, delete on supplier_delivery_lines from app_user;
revoke select, insert, update, delete on supplier_deliveries from app_user;

-- ----------------------------------------------------------------------------
-- 8 (reverse). RLS policies drop with their tables below; nothing to restore
--    on any pre-existing table (this migration added no policy to one).
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 7 (reverse). stock_movements.supplier_delivery_id -- drop the FK only; the
--    column and its index were added by 0014 and are NOT touched here (this
--    migration only activated the FK on top of a column 0014 already owns).
-- ----------------------------------------------------------------------------
alter table stock_movements drop constraint if exists stock_movements_supplier_delivery_fk;

-- ----------------------------------------------------------------------------
-- 6 (reverse). supplier_payment_allocations.
-- ----------------------------------------------------------------------------
drop table if exists supplier_payment_allocations;

-- ----------------------------------------------------------------------------
-- 5 (reverse). supplier_payments.
-- ----------------------------------------------------------------------------
drop table if exists supplier_payments;

-- ----------------------------------------------------------------------------
-- 4 (reverse). supplier_delivery_lines.
-- ----------------------------------------------------------------------------
drop table if exists supplier_delivery_lines;

-- ----------------------------------------------------------------------------
-- 3 (reverse). supplier_deliveries.
-- ----------------------------------------------------------------------------
drop table if exists supplier_deliveries;

-- ----------------------------------------------------------------------------
-- 2 (reverse). delivery_payment_status.
-- ----------------------------------------------------------------------------
drop type if exists delivery_payment_status;

-- Note: `document_type` enum's 'delivery' value is intentionally NOT
-- reverted here -- see header warning.

-- ----------------------------------------------------------------------------
-- Keep drizzle-kit's own bookkeeping (drizzle.__drizzle_migrations) in sync
-- with this rollback -- see db/README.md's "Rollback keeps drizzle's own
-- journal honest" section for the full argument. Down scripts are always run
-- in strict reverse order, so at the moment THIS script runs, the row for
-- THIS migration is always the current max(id) row.
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
