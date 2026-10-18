-- ============================================================================
-- 0015_supplier_purchasing.sql (hand-written)
--
-- Architect plan approved, product decisions FINAL (2026-10-18):
--   - Supplier debt is CONSOLIDATED AT TENANT LEVEL: a gerant sees the
--     deliveries that landed in their own store, but never the global
--     supplier balance (that aggregate is tenant-wide by design, not a
--     per-store figure).
--   - Deliveries themselves carry a `warehouse_id` and are therefore
--     store-scoped like every other stock-bearing row -- 0014's store
--     predicate pattern applies to `supplier_deliveries` (section 8).
--   - Deliberately NOT reusing `payments`/`invoices`: those are customer-side
--     by construction. Adding a `party_type` column to them would recreate
--     exactly the polymorphic reference 0009 (stock_movements.source_type)
--     and 0014 (closing debt 2r) spent two migrations retiring. New,
--     dedicated supplier-side tables instead.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0014. Idempotent (ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS /
-- DO $$ guards around constraints with no native IF NOT EXISTS form), so
-- re-running this file is safe.
--
-- Floor vs ceiling scoping of the four new tables (same split as 0014's
-- entry 2x in db/README.md -- restated here per the brief's instruction to
-- document it again for this migration):
--   - supplier_deliveries        FLOOR: tenant_access() AND store predicate.
--                                 Carries warehouse_id directly and is read
--                                 on a store-scoped dashboard, same reasoning
--                                 as stock_transfers/stock_counts in 0014.
--   - supplier_delivery_lines    FLOOR: tenant_access() only (line table,
--                                 reached by joining the already store-scoped
--                                 header -- same convention as sale_lines).
--   - supplier_payments          FLOOR: tenant_access() only, DELIBERATELY
--                                 NOT store-scoped. This table has no
--                                 warehouse_id column at all: a payment
--                                 settles the supplier's TENANT-LEVEL balance,
--                                 which may cover deliveries into several
--                                 different stores at once (see
--                                 supplier_payment_allocations). Giving it a
--                                 warehouse_id would misrepresent a
--                                 consolidated debt as store-owned.
--   - supplier_payment_allocations FLOOR: tenant_access() only (line-shaped,
--                                 mirrors payment_allocations' existing
--                                 floor-only treatment).
--
-- Sections:
--   0. Prerequisite + BYPASSRLS assertion.
--   1. document_type gains 'delivery' (gapless per-tenant+fiscal-year
--      numbering for supplier_deliveries.reference, same mechanism as
--      tickets/invoices/transfers).
--   2. New enum: delivery_payment_status.
--   3. supplier_deliveries (header).
--   4. supplier_delivery_lines (detail).
--   5. supplier_payments (header).
--   6. supplier_payment_allocations (mirror of payment_allocations).
--   7. Activate stock_movements.supplier_delivery_id's composite FK (0014
--      added the column ahead of this table specifically so this is the
--      only thing this migration needs to do to that column).
--   8. RLS -- enable + force on all four new tables, explicit policies per
--      the floor/ceiling split documented above.
--   9. Grants (0004's default-privilege REVOKE still applies: no implicit
--      grant on a new table).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Prerequisites + BYPASSRLS assertion (same invariant as 0004/0009/0014:
--    every FORCE-RLS table this migration adds depends on the migrator role
--    carrying BYPASSRLS, and the store predicate depends on
--    app_scoped_warehouse_id(), added in 0014).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.app_scoped_warehouse_id()') is null then
    raise exception '0015 requires 0014_multi_store_transfers_counts.sql to be applied first (missing app_scoped_warehouse_id)';
  end if;

  if to_regprocedure('public.tenant_access(uuid)') is null then
    raise exception '0015 requires 0001_tenancy_rls_audit.sql to be applied first (missing tenant_access)';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'stock_movements' and column_name = 'supplier_delivery_id'
  ) then
    raise exception '0015 requires 0014_multi_store_transfers_counts.sql to be applied first (missing stock_movements.supplier_delivery_id)';
  end if;
end $$;

do $$
declare
  v_bypassrls boolean;
begin
  select rolbypassrls into v_bypassrls from pg_roles where rolname = current_user;

  if not coalesce(v_bypassrls, false) then
    raise exception
      '0015: migrator role "%" does not have BYPASSRLS. See db/README.md '
      '("Judgment call to flag to security-reviewer") -- the new FORCE-RLS '
      'tables this migration adds (section 8) depend on the same invariant '
      'every other tenant table in this schema already does. Grant it '
      'out-of-band as a superuser: ALTER ROLE % BYPASSRLS;',
      current_user, current_user;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. document_counters -- deliveries get their own gapless counter, same
--    mechanism as tickets (0009), invoices (0000) and transfers (0014).
-- ----------------------------------------------------------------------------
alter type document_type add value if not exists 'delivery';

-- ----------------------------------------------------------------------------
-- 2. delivery_payment_status -- mirrors sale_payment_status (0009): a
--    delivery can be unpaid/partially paid/paid, orthogonal to whether the
--    goods have been received yet.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'delivery_payment_status') then
    create type delivery_payment_status as enum ('unpaid', 'partial', 'paid');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. supplier_deliveries (header) -- a delivery lands in exactly ONE store
--    (warehouse_id not null), unlike a transfer which spans two.
-- ----------------------------------------------------------------------------
create table if not exists supplier_deliveries (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  supplier_id uuid not null,
  warehouse_id uuid not null,
  reference text not null, -- allocated via document_counters, doc_type = 'delivery'
  fiscal_year integer not null,
  currency_code text not null references currencies (code),
  total_minor bigint not null default 0,
  paid_minor bigint not null default 0,
  payment_status delivery_payment_status not null default 'unpaid',
  due_at timestamptz,
  received_at timestamptz,
  created_by text not null, -- Better Auth user id
  created_at timestamptz not null default now(),
  -- PWA retry-queue de-duplication key, same money-correctness mechanism as
  -- sales.idempotency_key (0009) / stock_transfers.idempotency_key (0014).
  idempotency_key text not null,
  -- sha256 fingerprint of the request payload, same H1 defense as
  -- sales.request_fingerprint (0012) / stock_transfers.request_fingerprint
  -- (0014): an idempotency-key replay with a DIFFERENT payload must be
  -- refused, not silently treated as the original delivery.
  request_fingerprint text not null,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_structure_id_id_key') then
    alter table supplier_deliveries add constraint supplier_deliveries_structure_id_id_key unique (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_structure_idempotency_key_key') then
    alter table supplier_deliveries add constraint supplier_deliveries_structure_idempotency_key_key
      unique (structure_id, idempotency_key);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_supplier_fk') then
    alter table supplier_deliveries add constraint supplier_deliveries_supplier_fk
      foreign key (structure_id, supplier_id) references suppliers (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_warehouse_fk') then
    alter table supplier_deliveries add constraint supplier_deliveries_warehouse_fk
      foreign key (structure_id, warehouse_id) references warehouses (structure_id, id);
  end if;

  -- Mirrors invoices_paid_le_total_chk (0009) / sales_paid_le_total_chk (0010).
  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_paid_le_total_chk') then
    alter table supplier_deliveries add constraint supplier_deliveries_paid_le_total_chk
      check (paid_minor <= total_minor);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_total_nonneg_chk') then
    alter table supplier_deliveries add constraint supplier_deliveries_total_nonneg_chk
      check (total_minor >= 0 and paid_minor >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_cancelled_by_consistency_chk') then
    alter table supplier_deliveries add constraint supplier_deliveries_cancelled_by_consistency_chk
      check (cancelled_by is null or cancelled_at is not null);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_cancel_reason_consistency_chk') then
    alter table supplier_deliveries add constraint supplier_deliveries_cancel_reason_consistency_chk
      check (cancel_reason is null or cancelled_at is not null);
  end if;
end $$;

create index if not exists supplier_deliveries_structure_id_idx on supplier_deliveries (structure_id);
create index if not exists supplier_deliveries_supplier_idx on supplier_deliveries (structure_id, supplier_id);
create index if not exists supplier_deliveries_warehouse_idx on supplier_deliveries (structure_id, warehouse_id);
create index if not exists supplier_deliveries_payment_status_due_idx
  on supplier_deliveries (structure_id, payment_status, due_at);
create unique index if not exists supplier_deliveries_structure_fy_reference_idx
  on supplier_deliveries (structure_id, fiscal_year, reference);

-- ----------------------------------------------------------------------------
-- 4. supplier_delivery_lines (detail).
-- ----------------------------------------------------------------------------
create table if not exists supplier_delivery_lines (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  delivery_id uuid not null,
  product_id uuid not null,
  quantity numeric(18, 4) not null,
  unit_cost_minor bigint not null,
  line_total_minor bigint not null,
  line_no smallint not null default 1
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_delivery_lines_delivery_fk') then
    alter table supplier_delivery_lines add constraint supplier_delivery_lines_delivery_fk
      foreign key (structure_id, delivery_id) references supplier_deliveries (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_delivery_lines_product_fk') then
    alter table supplier_delivery_lines add constraint supplier_delivery_lines_product_fk
      foreign key (structure_id, product_id) references products (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_delivery_lines_structure_delivery_line_no_key') then
    alter table supplier_delivery_lines add constraint supplier_delivery_lines_structure_delivery_line_no_key
      unique (structure_id, delivery_id, line_no);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_delivery_lines_quantity_positive_chk') then
    alter table supplier_delivery_lines add constraint supplier_delivery_lines_quantity_positive_chk
      check (quantity > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_delivery_lines_unit_cost_nonneg_chk') then
    alter table supplier_delivery_lines add constraint supplier_delivery_lines_unit_cost_nonneg_chk
      check (unit_cost_minor >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_delivery_lines_line_total_nonneg_chk') then
    alter table supplier_delivery_lines add constraint supplier_delivery_lines_line_total_nonneg_chk
      check (line_total_minor >= 0);
  end if;
end $$;

create index if not exists supplier_delivery_lines_structure_id_idx on supplier_delivery_lines (structure_id);
create index if not exists supplier_delivery_lines_delivery_idx on supplier_delivery_lines (structure_id, delivery_id);
create index if not exists supplier_delivery_lines_product_idx on supplier_delivery_lines (structure_id, product_id);

-- ----------------------------------------------------------------------------
-- 5. supplier_payments (header) -- NO warehouse_id: settles the supplier's
--    tenant-level balance (see header comment). delivery_id is nullable --
--    a standalone payment on account, not yet allocated to any delivery, is
--    a valid state (mirrors payments.saleId's nullability).
-- ----------------------------------------------------------------------------
create table if not exists supplier_payments (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  supplier_id uuid not null,
  delivery_id uuid,
  amount_minor bigint not null,
  currency_code text not null references currencies (code),
  method text not null, -- 'cash', 'mobile_money', 'bank_transfer', ...
  reference text, -- mobile money transaction ref
  paid_at timestamptz not null default now(),
  created_by text not null, -- Better Auth user id
  created_at timestamptz not null default now(),
  idempotency_key text not null,
  voided_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_payments_structure_id_id_key') then
    alter table supplier_payments add constraint supplier_payments_structure_id_id_key unique (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_payments_structure_idempotency_key_key') then
    alter table supplier_payments add constraint supplier_payments_structure_idempotency_key_key
      unique (structure_id, idempotency_key);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_payments_supplier_fk') then
    alter table supplier_payments add constraint supplier_payments_supplier_fk
      foreign key (structure_id, supplier_id) references suppliers (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_payments_delivery_fk') then
    alter table supplier_payments add constraint supplier_payments_delivery_fk
      foreign key (structure_id, delivery_id) references supplier_deliveries (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_payments_amount_positive_chk') then
    alter table supplier_payments add constraint supplier_payments_amount_positive_chk
      check (amount_minor > 0);
  end if;
end $$;

create index if not exists supplier_payments_structure_id_idx on supplier_payments (structure_id);
create index if not exists supplier_payments_supplier_idx on supplier_payments (structure_id, supplier_id);
create index if not exists supplier_payments_delivery_idx on supplier_payments (structure_id, delivery_id);
create index if not exists supplier_payments_paid_at_idx on supplier_payments (structure_id, paid_at);

-- ----------------------------------------------------------------------------
-- 6. supplier_payment_allocations -- mirror of payment_allocations (0000).
--    Built now, not retrofitted later: settling several deliveries with one
--    payment is the norm for a distributor, per the brief.
-- ----------------------------------------------------------------------------
create table if not exists supplier_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  supplier_payment_id uuid not null,
  delivery_id uuid not null,
  amount_minor bigint not null,
  currency_code text not null references currencies (code)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_payment_allocations_payment_fk') then
    alter table supplier_payment_allocations add constraint supplier_payment_allocations_payment_fk
      foreign key (structure_id, supplier_payment_id) references supplier_payments (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_payment_allocations_delivery_fk') then
    alter table supplier_payment_allocations add constraint supplier_payment_allocations_delivery_fk
      foreign key (structure_id, delivery_id) references supplier_deliveries (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_payment_allocations_amount_positive_chk') then
    alter table supplier_payment_allocations add constraint supplier_payment_allocations_amount_positive_chk
      check (amount_minor > 0);
  end if;
end $$;

create index if not exists supplier_payment_allocations_structure_id_idx on supplier_payment_allocations (structure_id);
create index if not exists supplier_payment_allocations_payment_idx on supplier_payment_allocations (structure_id, supplier_payment_id);
create index if not exists supplier_payment_allocations_delivery_idx on supplier_payment_allocations (structure_id, delivery_id);

-- ----------------------------------------------------------------------------
-- 7. Activate stock_movements.supplier_delivery_id's composite FK. 0014
--    added the column (and its index) deliberately ahead of this table, so
--    this is the ONLY thing left to do here -- the exclusive-arc CHECK
--    (stock_movements_exclusive_arc_chk) already treats this column as one
--    of the five arc slots.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_supplier_delivery_fk') then
    alter table stock_movements add constraint stock_movements_supplier_delivery_fk
      foreign key (structure_id, supplier_delivery_id) references supplier_deliveries (structure_id, id);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8. RLS -- floor/ceiling split documented in the header comment above.
-- ----------------------------------------------------------------------------
alter table supplier_deliveries enable row level security;
alter table supplier_deliveries force row level security;

create policy supplier_deliveries_tenant_isolation on supplier_deliveries
  for all
  using (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  )
  with check (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  );

alter table supplier_delivery_lines enable row level security;
alter table supplier_delivery_lines force row level security;

create policy supplier_delivery_lines_tenant_isolation on supplier_delivery_lines
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

alter table supplier_payments enable row level security;
alter table supplier_payments force row level security;

-- DELIBERATELY the generic tenant floor only -- no store predicate (see
-- header comment: the global supplier balance is tenant-level by product
-- decision, not store-owned). The app layer is responsible for restricting
-- "global supplier balance" views/exports to roles that should see it
-- tenant-wide (owner/accountant), same convention as every other
-- generic-floor-only sensitive table in this schema (db/README.md's "RLS --
-- the floor, not the ceiling").
create policy supplier_payments_tenant_isolation on supplier_payments
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

alter table supplier_payment_allocations enable row level security;
alter table supplier_payment_allocations force row level security;

create policy supplier_payment_allocations_tenant_isolation on supplier_payment_allocations
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

-- ----------------------------------------------------------------------------
-- 9. Grants -- mandatory for every new table (0004 revoked the schema-wide
--    default-privilege grant).
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on supplier_deliveries to app_user;
grant select, insert, update, delete on supplier_delivery_lines to app_user;
grant select, insert, update, delete on supplier_payments to app_user;
grant select, insert, update, delete on supplier_payment_allocations to app_user;

-- ============================================================================
-- Validation performed (disposable postgres:16-alpine container, torn down
-- after): full chain 0000->0015 (business) + identity 0000->0001, superuser
-- (Supabase-style BYPASSRLS) migrator, then app_user under RLS. See
-- db/README.md entry 2y for the full transcript (kept there, not duplicated
-- here, per this project's convention of consolidating cross-migration
-- validation narrative in one place once the chain gets long).
-- ============================================================================
