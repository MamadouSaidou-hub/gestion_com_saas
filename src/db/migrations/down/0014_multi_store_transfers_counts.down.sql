-- ============================================================================
-- MANUAL rollback for 0014_multi_store_transfers_counts.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0014.
--
-- WARNING: destructive for any data populated against 0014's new tables/
-- columns -- it DROPs stock_transfers/stock_transfer_lines/stock_counts/
-- stock_count_lines outright and drops warehouses.code/kind/is_active/
-- address/phone, memberships.warehouse_id, payments.warehouse_id,
-- stock_movements.transfer_id/stock_count_id/supplier_delivery_id. Only run
-- this during development, never against a tenant-carrying environment
-- already using multi-store. The 'transfer' value added to the
-- `document_type` enum (section 5) is NOT removed here, same reason 0009's
-- down script leaves 'ticket' in place: PostgreSQL has no
-- `ALTER TYPE ... DROP VALUE`, and this environment has no document_counters
-- rows with doc_type = 'transfer' yet.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 9 (reverse). Grants.
-- ----------------------------------------------------------------------------
revoke select, insert, update, delete on stock_count_lines from app_user;
revoke select, insert, update, delete on stock_counts from app_user;
revoke select, insert, update, delete on stock_transfer_lines from app_user;
revoke select, insert, update, delete on stock_transfers from app_user;

-- ----------------------------------------------------------------------------
-- 8 (reverse). RLS -- restore the pre-0014 generic-floor-only policies on
--    the existing tables, drop the policies/RLS on the new tables (the
--    tables themselves are dropped below anyway).
-- ----------------------------------------------------------------------------
drop policy if exists payments_tenant_isolation on payments;
create policy payments_tenant_isolation on payments
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

drop policy if exists sales_tenant_isolation on sales;
create policy sales_tenant_isolation on sales
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

drop policy if exists stock_levels_tenant_isolation on stock_levels;
create policy stock_levels_tenant_isolation on stock_levels
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

drop policy if exists stock_movements_tenant_isolation on stock_movements;
create policy stock_movements_tenant_isolation on stock_movements
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

-- ----------------------------------------------------------------------------
-- 7 (reverse). stock_movements -- restore the pre-0014 CHECK, drop the new
--    columns.
-- ----------------------------------------------------------------------------
alter table stock_movements drop constraint if exists stock_movements_exclusive_arc_chk;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stock_movements_source_consistency_chk'
  ) then
    alter table stock_movements
      add constraint stock_movements_source_consistency_chk
      check (
        case
          when source_type = 'sale' then sale_id is not null and source_id is null
          else sale_id is null
        end
      );
  end if;
end $$;

drop index if exists stock_movements_supplier_delivery_idx;
drop index if exists stock_movements_stock_count_idx;
drop index if exists stock_movements_transfer_idx;
alter table stock_movements drop constraint if exists stock_movements_stock_count_fk;
alter table stock_movements drop constraint if exists stock_movements_transfer_fk;
alter table stock_movements drop column if exists supplier_delivery_id;
alter table stock_movements drop column if exists stock_count_id;
alter table stock_movements drop column if exists transfer_id;

-- ----------------------------------------------------------------------------
-- 6 (reverse). New tables -- RLS policies drop with the tables; drop lines
--    before headers (FK direction), counts/transfers before warehouses are
--    touched further up the chain is not required since warehouses itself
--    is only altered, not dropped.
-- ----------------------------------------------------------------------------
drop table if exists stock_count_lines;
drop table if exists stock_counts;
drop type if exists stock_count_status;

drop table if exists stock_transfer_lines;
drop table if exists stock_transfers;
drop type if exists stock_transfer_status;

-- Note: `document_type` enum's 'transfer' value is intentionally NOT
-- reverted here -- see header warning.

-- ----------------------------------------------------------------------------
-- 4 (reverse). payments.warehouse_id.
-- ----------------------------------------------------------------------------
drop index if exists payments_structure_warehouse_idx;
alter table payments drop constraint if exists payments_warehouse_fk;
alter table payments drop column if exists warehouse_id;

-- ----------------------------------------------------------------------------
-- 3 (reverse). app_scoped_warehouse_id().
-- ----------------------------------------------------------------------------
revoke execute on function app_scoped_warehouse_id() from app_user;
drop function if exists app_scoped_warehouse_id();

-- ----------------------------------------------------------------------------
-- 2 (reverse). memberships.warehouse_id.
-- ----------------------------------------------------------------------------
drop index if exists memberships_structure_warehouse_idx;
alter table memberships drop constraint if exists memberships_owner_no_warehouse_chk;
alter table memberships drop constraint if exists memberships_warehouse_fk;
alter table memberships drop column if exists warehouse_id;

-- ----------------------------------------------------------------------------
-- 1 (reverse). warehouses.
-- ----------------------------------------------------------------------------
drop index if exists warehouses_structure_kind_idx;
drop index if exists warehouses_structure_code_idx;
alter table warehouses drop constraint if exists warehouses_code_nonempty_chk;
alter table warehouses drop column if exists phone;
alter table warehouses drop column if exists address;
alter table warehouses drop column if exists is_active;
alter table warehouses drop column if exists kind;
alter table warehouses drop column if exists code;
drop type if exists warehouse_kind;

-- ----------------------------------------------------------------------------
-- Keep drizzle-kit's own bookkeeping (drizzle.__drizzle_migrations) in sync
-- with this rollback, or the next `migrate:all` will trust the journal over
-- the live schema and silently no-op.
--
-- drizzle-orm's migrate() trusts ONLY drizzle.__drizzle_migrations, and only
-- the SINGLE most-recently-inserted row in it (`order by created_at desc
-- limit 1` — see node_modules/drizzle-orm/pg-core/dialect.js). It never
-- re-checks the live schema. If a down script drops this migration's
-- tables/policies/functions but leaves that row in place, the next
-- `migrate:all` sees the journal claims this migration (and everything
-- before it) is already applied, skips re-running it, and prints
-- "Migrations complete" / exits 0 — even though the business schema it just
-- dropped is now gone. Reproduced by actual execution against a disposable
-- container; see db/README.md's "Rollback keeps drizzle's own journal
-- honest" section for the full before/after transcript.
--
-- Fix: every down script deletes its own row. Down scripts are always run
-- in strict reverse order (highest-numbered first — db/README.md), so at
-- the moment THIS script runs, the row for THIS migration is always the
-- current max(id) row. No need to match drizzle's sha256(file content)
-- hash, which would be fragile to reproduce byte-for-byte inside a hand-
-- written SQL file. This also makes a PARTIAL rollback (e.g. down 0014 and
-- 0013 only, then re-migrate) correct: after those two deletes, the journal's
-- latest row is 0012's, so `migrate:all` re-applies exactly 0013 and 0014 —
-- not the whole chain, and not a no-op.
do $cleanup$
begin
  if not exists (select 1 from drizzle.__drizzle_migrations) then
    raise exception 'drizzle.__drizzle_migrations is already empty -- down scripts were not run in strict reverse order, or this one already ran. Refusing to delete nothing silently.';
  end if;

  delete from drizzle.__drizzle_migrations
  where id = (select max(id) from drizzle.__drizzle_migrations);
end
$cleanup$;
