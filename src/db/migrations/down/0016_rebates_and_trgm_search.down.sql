-- ============================================================================
-- MANUAL rollback for 0016_rebates_and_trgm_search.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0016.
--
-- WARNING: destructive for any data populated against 0016's new tables/
-- columns -- it DROPs rebate_scales/rebate_tiers/rebate_grants outright and
-- drops customers.is_active/credit_limit_minor/default_payment_terms_days/
-- address/notes, and the five trgm GIN indexes. pg_trgm itself is left
-- installed (dropping it would be safe here since nothing else in this
-- schema depends on it, but EXTENSIONs are treated as a shared, rarely-
-- toggled operational concern in this project -- same reasoning pgcrypto is
-- never dropped by any down script -- so it is left in place, harmless with
-- no indexes using it).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 8 (reverse). pg_trgm GIN indexes + grants. Extension itself NOT dropped
--    (see header warning).
-- ----------------------------------------------------------------------------
drop index if exists suppliers_name_trgm_idx;
drop index if exists customers_phone_trgm_idx;
drop index if exists customers_name_trgm_idx;
drop index if exists products_sku_trgm_idx;
drop index if exists products_name_trgm_idx;

revoke execute on all functions in schema extensions from app_user;
-- Re-assert PUBLIC stays locked out (belt-and-suspenders, matches 0004's
-- own convention of restating this revoke rather than assuming it holds).
revoke execute on all functions in schema extensions from public;

-- ----------------------------------------------------------------------------
-- 7 (reverse). customers extra columns.
-- ----------------------------------------------------------------------------
drop index if exists customers_structure_is_active_idx;
alter table customers drop constraint if exists customers_payment_terms_nonneg_chk;
alter table customers drop constraint if exists customers_credit_limit_nonneg_chk;
alter table customers drop column if exists notes;
alter table customers drop column if exists address;
alter table customers drop column if exists default_payment_terms_days;
alter table customers drop column if exists credit_limit_minor;
alter table customers drop column if exists is_active;

-- ----------------------------------------------------------------------------
-- 6 (reverse). Grants on the three new tables (dropped below anyway, but
--    explicit for symmetry with every other down script in this project).
-- ----------------------------------------------------------------------------
revoke select, insert, update, delete on rebate_grants from app_user;
revoke select, insert, update, delete on rebate_tiers from app_user;
revoke select, insert, update, delete on rebate_scales from app_user;

-- ----------------------------------------------------------------------------
-- 5/4/3/2 (reverse). rebate_grants / rebate_tiers / rebate_scales + enums.
--    RLS policies drop with their tables.
-- ----------------------------------------------------------------------------
drop table if exists rebate_grants;
drop table if exists rebate_tiers;
drop table if exists rebate_scales;

drop type if exists rebate_grant_trigger;
drop type if exists rebate_mode;
drop type if exists rebate_model;

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
