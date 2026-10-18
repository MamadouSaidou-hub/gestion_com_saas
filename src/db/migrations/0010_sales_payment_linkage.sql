-- ============================================================================
-- 0010_sales_payment_linkage.sql (hand-written)
--
-- Gap found while implementing `confirmSale` (Phase 1 step 3): 0009 added
-- `sales.payment_status` and `payments.idempotency_key`/`reference`, but no
-- column anywhere actually LINKS a payment collected at sale-confirmation
-- time back to the sale it paid for. `invoices.sale_id` exists, but
-- "tickets by default, invoice on demand" means no invoice exists yet at
-- confirmation time -- so a payment taken at the till has nothing to
-- attach to.
--
-- Two additive, backward-compatible columns, each mirroring an existing
-- pattern exactly:
--   1. `payments.sale_id` -- nullable, composite-FK'd to `sales`, same shape
--      as `stock_movements.sale_id` (0009, section 4). Nullable because a
--      payment can also be recorded later, standalone, against an invoice
--      via `payment_allocations`, independent of any single sale.
--   2. `sales.paid_minor` -- denormalized running total, maintained
--      in-transaction by `confirmSale`, mirroring `invoices.paid_minor`
--      (0009, section 5.c) exactly, so "en attente" (receivables) for a
--      ticket-only sale doesn't need an aggregate join over `payments` on
--      every dashboard load.
--
-- Both tables already have RLS policies at the generic tenant floor
-- (`tenant_access(structure_id)`, from 0001's `tenant_tables` loop) and the
-- per-table GRANTs from 0001 already cover these existing tables -- no new
-- RLS policy or GRANT is needed for an added column.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. payments.sale_id
-- ----------------------------------------------------------------------------
alter table payments add column if not exists sale_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_sale_fk'
  ) then
    alter table payments
      add constraint payments_sale_fk
      foreign key (structure_id, sale_id) references sales (structure_id, id);
  end if;
end $$;

create index if not exists payments_structure_sale_idx on payments (structure_id, sale_id);

-- ----------------------------------------------------------------------------
-- 2. sales.paid_minor
-- ----------------------------------------------------------------------------
alter table sales add column if not exists paid_minor bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sales_paid_le_total_chk'
  ) then
    alter table sales
      add constraint sales_paid_le_total_chk
      check (paid_minor <= total_minor);
  end if;
end $$;

-- ============================================================================
-- Verification performed (disposable postgres:16-alpine container, chain
-- 0000->0010 + identity 0000->0001, migrator role):
--   - both ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements are
--     idempotent: re-running this file a second time against an
--     already-migrated database is a no-op (confirmed by execution).
--   - `insert into payments (..., sale_id) values (..., '<other-tenant-sale-id>')`
--     with a sale_id belonging to a DIFFERENT tenant's sale -> rejected with
--     foreign_key_violation (23503), same guarantee as
--     stock_movements_sale_fk.
--   - `insert into sales (..., total_minor, paid_minor) values (..., 1000, 1500)`
--     (overpayment) -> rejected with check_violation on
--     sales_paid_le_total_chk; `paid_minor = total_minor` succeeds.
-- ============================================================================
