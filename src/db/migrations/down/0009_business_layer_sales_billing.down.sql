-- ============================================================================
-- MANUAL rollback for 0009_business_layer_sales_billing.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0009.
--
-- WARNING: this is a destructive rollback for any data populated against the
-- 0009 columns (idempotency_key, ticket_number, paid_minor, ...) — it DROPs
-- those columns outright. Only run this during development, never against a
-- tenant-carrying environment with real sales/payments already using these
-- columns. The 'ticket' value added to the `document_type` enum (section 1
-- of 0009) is NOT removed here: PostgreSQL has no `ALTER TYPE ... DROP
-- VALUE`, and removing an enum label safely requires rebuilding the type
-- (CREATE new type, ALTER every column using it, DROP old type) — out of
-- scope for a rollback of a schema that, per 0009, has no rows using
-- doc_type = 'ticket' yet in this environment. If this is ever replayed
-- against an environment with real 'ticket' rows in document_counters,
-- that data migration must be done by hand first.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 7 (reverse). Grants.
-- ----------------------------------------------------------------------------
revoke select, insert, update, delete on structure_settings from app_user;

-- ----------------------------------------------------------------------------
-- 6 (reverse). Dashboard indexes.
-- ----------------------------------------------------------------------------
drop index if exists sale_lines_structure_product_sale_idx;
drop index if exists invoices_structure_status_due_idx;
drop index if exists payments_structure_received_idx;
drop index if exists sales_structure_created_by_confirmed_idx;
drop index if exists sales_structure_status_confirmed_idx;

-- ----------------------------------------------------------------------------
-- 5.d (reverse). payments.
-- ----------------------------------------------------------------------------
alter table payments drop constraint if exists payments_structure_idempotency_key_key;
alter table payments drop column if exists voided_at;
alter table payments drop column if exists reference;
alter table payments drop column if exists idempotency_key;

-- ----------------------------------------------------------------------------
-- 5.c (reverse). invoices.
-- ----------------------------------------------------------------------------
drop index if exists invoices_credit_note_of_invoice_idx;
alter table invoices drop constraint if exists invoices_credit_note_of_invoice_fk;
alter table invoices drop constraint if exists invoices_paid_le_total_chk;
alter table invoices drop column if exists credit_note_of_invoice_id;
alter table invoices drop column if exists cancelled_at;
alter table invoices drop column if exists paid_minor;

-- ----------------------------------------------------------------------------
-- 5.b (reverse). sale_lines.
-- ----------------------------------------------------------------------------
alter table sale_lines drop constraint if exists sale_lines_structure_sale_line_no_key;
alter table sale_lines drop column if exists line_no;
alter table sale_lines drop column if exists unit_cost_minor;
alter table sale_lines drop column if exists discount_minor;
alter table sale_lines drop column if exists vat_rate;

-- ----------------------------------------------------------------------------
-- 5.a (reverse). sales.
-- ----------------------------------------------------------------------------
drop index if exists sales_structure_fy_ticket_idx;
alter table sales drop constraint if exists sales_cancelled_consistency_chk;
alter table sales drop constraint if exists sales_structure_idempotency_key_key;
alter table sales drop column if exists void_reason;
alter table sales drop column if exists cancelled_by;
alter table sales drop column if exists cancelled_at;
alter table sales drop column if exists payment_status;
alter table sales drop column if exists ticket_number;
alter table sales drop column if exists fiscal_year;
alter table sales drop column if exists discount_minor;
alter table sales drop column if exists vat_minor;
alter table sales drop column if exists subtotal_minor;
alter table sales drop column if exists idempotency_key;

drop type if exists sale_payment_status;

-- ----------------------------------------------------------------------------
-- 4 (reverse). stock_movements.
-- ----------------------------------------------------------------------------
drop index if exists stock_movements_sale_idx;
alter table stock_movements drop constraint if exists stock_movements_source_consistency_chk;
alter table stock_movements drop constraint if exists stock_movements_sale_fk;
alter table stock_movements drop column if exists sale_id;

-- ----------------------------------------------------------------------------
-- 3 (reverse). products.
-- ----------------------------------------------------------------------------
alter table products drop constraint if exists products_low_stock_threshold_nonneg_chk;
alter table products drop column if exists default_cost_minor;
alter table products drop column if exists low_stock_threshold;

-- ----------------------------------------------------------------------------
-- 2 (reverse). structure_settings.
-- ----------------------------------------------------------------------------
drop policy if exists structure_settings_tenant_isolation on structure_settings;
drop table if exists structure_settings;

-- Note: `document_type` enum's 'ticket' value is intentionally NOT reverted
-- here — see header warning.

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
