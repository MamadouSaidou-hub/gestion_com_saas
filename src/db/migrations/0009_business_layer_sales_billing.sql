-- ============================================================================
-- Hand-written migration: schema for the business application layer (sales,
-- tickets/invoices, payments, stock-shortage override, separation-of-duties
-- config) approved by architect + user decisions, 2026-10-17.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0008. Idempotent (ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS /
-- DO $$ guards around constraints that have no native IF NOT EXISTS form), so
-- re-running this file is safe. Every statement below pairs a GRANT with any
-- new table, per 0004's default-privilege REVOKE: app_user gets NO implicit
-- grant on a new table, each one must be explicit (section 7).
--
-- Product decisions this migration encodes (final, approved):
--   - Credit sales are allowed: a sale can be unpaid/partially paid.
--     `sales.payment_status` + the new dashboard indexes (section 6) make
--     "receivables" a first-class, cheaply queryable metric.
--   - Stock shortage blocks by default; override is a per-operation,
--     permission-gated action (`stock:oversell`, manager/owner), NOT a
--     structure-level toggle. There is deliberately NO new column/table here
--     for that permission: it is an application-layer authz check (per
--     CLAUDE.md's non-negotiable that RLS is the floor, not the ceiling) and
--     every use of it is written to `audit_log` by the app via
--     `audit_log_append(...)` (already built, 0001) — no new DB surface
--     needed, and adding a structure-level "allow_negative_stock" flag would
--     silently defeat the per-operation/per-permission design, so it is
--     intentionally NOT added.
--   - Tickets by default, invoices on demand: `sales.ticket_number` is
--     allocated from `document_counters` (doc_type = 'ticket', new enum
--     value added in section 1) at confirmation. `invoices.sale_id` already
--     existed (nullable) since 0000 — an invoice row, with its own
--     `document_counters` doc_type = 'invoice' number, is created later,
--     independently, only when someone requests one. A sale can therefore
--     have a ticket and no invoice indefinitely, then gain an invoice
--     without any schema change.
--   - Separation of duties (D3) is OFF by default per structure: the new
--     `structure_settings.sod_threshold_minor` is NULLable and NULL means
--     "disabled" — a brand new structure needs no second actor. An owner
--     can set a threshold later (app layer); amounts at or above it then
--     require the second-actor flow (not built here — app-layer concern).
--   - Single implicit warehouse in v1: no schema change — `warehouses`
--     already supports multiple, `sales.warehouse_id` is already required;
--     the app layer just stops forcing a warehouse-selector UI, and may
--     default to the structure's `is_default` warehouse.
--
-- Sections:
--   0. Self-test prerequisites + BYPASSRLS assertion (same invariant 0004
--      established; re-asserted here because this migration adds a new
--      FORCE-RLS tenant table and composite FKs that depend on it holding).
--   1. New enum values / types: document_type gains 'ticket';
--      sale_payment_status (unpaid/partial/paid) is new.
--   2. New table: structure_settings (per-tenant SoD threshold + discount cap).
--   3. products: low_stock_threshold, default_cost_minor.
--   4. stock_movements: harden the polymorphic source reference (A2) — add
--      an explicit, composite-FK'd sale_id column, retire source_type/
--      source_id to the 'sale' case only going forward.
--   5. sales / sale_lines / invoices / payments: money-correctness and
--      margin-tracking columns (B).
--   6. Dashboard indexes (C).
--   7. Grants for the new table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Self-test prerequisites + BYPASSRLS re-assertion.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.invitations_immutable_fields_guard()') is null then
    raise exception '0009 requires 0001-0008 to be applied first (missing invitations_immutable_fields_guard, added in 0007/0008)';
  end if;

  if to_regprocedure('public.tenant_access(uuid)') is null then
    raise exception '0009 requires 0001_tenancy_rls_audit.sql to be applied first (missing tenant_access)';
  end if;
end $$;

-- Same invariant as 0004: every FORCE-RLS table whose rows are read across
-- membership visibility by a SECURITY DEFINER function depends on the
-- migrator role carrying BYPASSRLS. This migration adds a new FORCE-RLS
-- table (structure_settings, section 2) and the generic tenant_access()
-- policy on it is evaluated the same way as every other tenant table, so the
-- same precondition must hold. Fail loudly, naming the role, rather than let
-- a misconfigured non-Supabase migrator crash mysteriously later.
do $$
declare
  v_bypassrls boolean;
begin
  select rolbypassrls into v_bypassrls from pg_roles where rolname = current_user;

  if not coalesce(v_bypassrls, false) then
    raise exception
      '0009: migrator role "%" does not have BYPASSRLS. See db/README.md '
      '("Judgment call to flag to security-reviewer") and 0004''s identical '
      'assertion. Grant it out-of-band as a superuser: ALTER ROLE % BYPASSRLS;',
      current_user, current_user;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Enum changes.
-- ----------------------------------------------------------------------------

-- `document_counters.doc_type` (document_type enum) needs a 'ticket' value
-- distinct from 'invoice' so the two counters are independent gapless
-- sequences per the approved decision (tickets by default, invoice on
-- demand) — reuses the existing doc_type column/mechanism rather than
-- inventing a second numbering mechanism.
alter type document_type add value if not exists 'ticket';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sale_payment_status') then
    create type sale_payment_status as enum ('unpaid', 'partial', 'paid');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. structure_settings — per-tenant business-policy config.
--
-- Separate table rather than more columns on `structures`, for the same
-- reason `tax_settings` (0000) is already separate from `structures`: keeps
-- the tenant-identity row (name/country/currency/valuation_method, gated by
-- the owner-only `structures_update` policy) decoupled from mutable
-- operational policy knobs that are expected to grow (SoD threshold today;
-- discount cap today; more later) without repeatedly widening the identity
-- table. Same 1-row-per-structure shape as `tax_settings`.
--
-- `sod_threshold_minor` NULL = separation-of-duties disabled (the approved
-- default for a new structure — a one-person shop works out of the box). A
-- non-NULL value is the amount (in the structure's minor currency unit) at
-- or above which a sensitive action (cancellation/avoir, price override,
-- cash reconciliation — per CLAUDE.md D3) requires a second actor; enforced
-- entirely at the app layer, this table only holds the config.
-- `max_discount_pct` NULL = no cap (also app-enforced).
-- ----------------------------------------------------------------------------
create table if not exists structure_settings (
  structure_id uuid primary key references structures (id) on delete cascade,
  sod_threshold_minor bigint,
  max_discount_pct numeric(5, 2),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'structure_settings_sod_threshold_nonneg_chk'
  ) then
    alter table structure_settings
      add constraint structure_settings_sod_threshold_nonneg_chk
      check (sod_threshold_minor is null or sod_threshold_minor >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'structure_settings_max_discount_pct_range_chk'
  ) then
    alter table structure_settings
      add constraint structure_settings_max_discount_pct_range_chk
      check (max_discount_pct is null or (max_discount_pct >= 0 and max_discount_pct <= 100));
  end if;
end $$;

alter table structure_settings enable row level security;
alter table structure_settings force row level security;

-- Generic tenant floor, same convention as `tax_settings` (0001's
-- tenant_tables loop) — RLS here only enforces "this row belongs to a
-- structure I'm an active member of", not per-role write rules. FLAG FOR
-- security-reviewer: unlike most generic-floor tables, this one holds the
-- SoD threshold itself — a `cashier` or `stock_keeper` able to write this
-- row could set `sod_threshold_minor` sky-high or NULL to defeat the
-- second-actor control entirely. The app layer MUST restrict writes on this
-- table to `owner` (per the architect's decision that only an owner may
-- enable/tune SoD), the same way it already must restrict e.g. `tax_settings`
-- writes to owner/accountant — RLS does not encode that distinction for
-- either table today, by established convention, not an oversight specific
-- to this migration.
drop policy if exists structure_settings_tenant_isolation on structure_settings;
create policy structure_settings_tenant_isolation on structure_settings
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

-- ----------------------------------------------------------------------------
-- 3. products — low-stock badge threshold, default cost for CUMP seeding.
-- ----------------------------------------------------------------------------
alter table products add column if not exists low_stock_threshold numeric(18, 4);
alter table products add column if not exists default_cost_minor bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_low_stock_threshold_nonneg_chk'
  ) then
    alter table products
      add constraint products_low_stock_threshold_nonneg_chk
      check (low_stock_threshold is null or low_stock_threshold >= 0);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. stock_movements — harden the polymorphic source reference (architect's
--    option A2). `source_type`/`source_id` is the only reference in the
--    schema escaping the composite-FK pattern; a sale-driven movement could
--    reference another tenant's sale with no DB guarantee. Add an explicit,
--    nullable, composite-FK'd `sale_id` column and a CHECK that makes it
--    mutually exclusive with (and consistent with) `source_type`/`source_id`.
--
--    `source_type`/`source_id` are KEPT for sources that have no dedicated
--    table yet (e.g. 'manual', 'adjustment') — retire them to their own
--    composite-FK column (e.g. `purchase_order_id`) the same way, in a
--    future migration, once that table exists. Tables are empty today, so
--    this is cheap now and would be a data migration later.
-- ----------------------------------------------------------------------------
alter table stock_movements add column if not exists sale_id uuid;

-- Same backfill guard convention as sales/payments' idempotency_key below:
-- fail loudly and readably rather than let a raw CHECK-violation surface if
-- this is ever replayed against an environment where existing rows already
-- have source_type = 'sale' (pre-dating this migration, now with sale_id
-- freshly NULL). On the empty tables this environment has today, this is a
-- no-op.
do $$
begin
  if exists (select 1 from stock_movements where source_type = 'sale' and sale_id is null) then
    raise exception '0009: stock_movements has rows with source_type = ''sale'' and no sale_id — backfill sale_id (or reclassify source_type) before re-running this migration';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stock_movements_sale_fk'
  ) then
    alter table stock_movements
      add constraint stock_movements_sale_fk
      foreign key (structure_id, sale_id) references sales (structure_id, id);
  end if;

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

create index if not exists stock_movements_sale_idx on stock_movements (structure_id, sale_id);

-- ----------------------------------------------------------------------------
-- 5.a sales — idempotent retry key, money breakdown, ticket numbering,
--     payment status, cancellation.
-- ----------------------------------------------------------------------------
alter table sales add column if not exists idempotency_key text;
alter table sales add column if not exists subtotal_minor bigint not null default 0;
alter table sales add column if not exists vat_minor bigint not null default 0;
alter table sales add column if not exists discount_minor bigint not null default 0;
alter table sales add column if not exists fiscal_year integer;
alter table sales add column if not exists ticket_number bigint;
alter table sales add column if not exists payment_status sale_payment_status not null default 'unpaid';
alter table sales add column if not exists cancelled_at timestamptz;
alter table sales add column if not exists cancelled_by text; -- Better Auth user id, same bare-text convention as created_by
alter table sales add column if not exists void_reason text;

-- idempotency_key becomes mandatory going forward (PWA retry queue's
-- money-correctness mechanism: a double-submit must hit this unique index,
-- not a pre-SELECT race). Tables are empty in this environment, so the
-- NOT NULL can be applied directly; if this is ever replayed against a
-- non-empty `sales` table, backfill a synthetic key per row before this line.
do $$
begin
  if exists (select 1 from sales where idempotency_key is null) then
    raise exception '0009: sales has rows with NULL idempotency_key — backfill before re-running this migration';
  end if;
end $$;
alter table sales alter column idempotency_key set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sales_structure_idempotency_key_key'
  ) then
    alter table sales
      add constraint sales_structure_idempotency_key_key
      unique (structure_id, idempotency_key);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sales_cancelled_consistency_chk'
  ) then
    alter table sales
      add constraint sales_cancelled_consistency_chk
      check ((status = 'cancelled') = (cancelled_at is not null));
  end if;
end $$;

-- Gapless ticket numbering per structure+fiscal year, from document_counters
-- (doc_type = 'ticket'); NULL for draft sales that never got confirmed. The
-- partial unique index (not a plain UNIQUE) is required precisely because
-- multiple draft rows legitimately share ticket_number = NULL.
create unique index if not exists sales_structure_fy_ticket_idx
  on sales (structure_id, fiscal_year, ticket_number)
  where ticket_number is not null;

-- ----------------------------------------------------------------------------
-- 5.b sale_lines — VAT/discount per line, CUMP cost snapshot, line ordering.
-- ----------------------------------------------------------------------------
alter table sale_lines add column if not exists vat_rate numeric(5, 2) not null default 0;
alter table sale_lines add column if not exists discount_minor bigint not null default 0;
-- CUMP snapshot at sale time — without it gross margin is unknowable
-- retroactively once stock_levels' moving average has since changed.
alter table sale_lines add column if not exists unit_cost_minor bigint not null default 0;
alter table sale_lines add column if not exists line_no smallint not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sale_lines_structure_sale_line_no_key'
  ) then
    alter table sale_lines
      add constraint sale_lines_structure_sale_line_no_key
      unique (structure_id, sale_id, line_no);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5.c invoices — denormalized paid_minor (receivables without an aggregate
--     join on every dashboard load), cancellation, credit notes.
-- ----------------------------------------------------------------------------
alter table invoices add column if not exists paid_minor bigint not null default 0;
alter table invoices add column if not exists cancelled_at timestamptz;
alter table invoices add column if not exists credit_note_of_invoice_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_paid_le_total_chk'
  ) then
    alter table invoices
      add constraint invoices_paid_le_total_chk
      check (paid_minor <= total_minor);
  end if;

  -- Composite self-FK, same pattern as product_categories.parent_id: a
  -- credit note must reference an invoice in the SAME tenant.
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_credit_note_of_invoice_fk'
  ) then
    alter table invoices
      add constraint invoices_credit_note_of_invoice_fk
      foreign key (structure_id, credit_note_of_invoice_id) references invoices (structure_id, id);
  end if;
end $$;

create index if not exists invoices_credit_note_of_invoice_idx
  on invoices (structure_id, credit_note_of_invoice_id);

-- `invoices.sale_id` (nullable since 0000) already supports "ticket now,
-- invoice later": an invoice row is INSERTed against an already-confirmed
-- sale whenever someone requests one — no schema change needed for that
-- part, confirmed here by inspection, not by adding a new column.

-- ----------------------------------------------------------------------------
-- 5.d payments — idempotent retry key, mobile-money reference, voiding.
-- ----------------------------------------------------------------------------
alter table payments add column if not exists idempotency_key text;
alter table payments add column if not exists reference text; -- mobile money transaction ref
alter table payments add column if not exists voided_at timestamptz;

do $$
begin
  if exists (select 1 from payments where idempotency_key is null) then
    raise exception '0009: payments has rows with NULL idempotency_key — backfill before re-running this migration';
  end if;
end $$;
alter table payments alter column idempotency_key set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_structure_idempotency_key_key'
  ) then
    alter table payments
      add constraint payments_structure_idempotency_key_key
      unique (structure_id, idempotency_key);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Dashboard indexes (C) — CA, encaissé, en attente (receivables), top
--    products, day/week/month series, per-seller breakdown + cashier's
--    "own sales only" scope.
-- ----------------------------------------------------------------------------
create index if not exists sales_structure_status_confirmed_idx
  on sales (structure_id, status, confirmed_at);

create index if not exists sales_structure_created_by_confirmed_idx
  on sales (structure_id, created_by, confirmed_at);

create index if not exists payments_structure_received_idx
  on payments (structure_id, received_at);

create index if not exists invoices_structure_status_due_idx
  on invoices (structure_id, status, due_at);

-- Top-products-by-30-day-window aggregation joins sale_lines to sales
-- (filtered by the index above on confirmed_at) via sale_id, then groups by
-- product. This composite + INCLUDE index lets that join/group-by run as an
-- index scan on sale_lines without a heap fetch for the aggregated columns.
create index if not exists sale_lines_structure_product_sale_idx
  on sale_lines (structure_id, product_id, sale_id) include (quantity, line_total_minor);

-- ----------------------------------------------------------------------------
-- 7. Grants — mandatory for the new table (0004 revoked the schema-wide
--    default-privilege grant; every new table's own migration must GRANT
--    app_user explicitly). Columns added to EXISTING tables need no new
--    GRANT (table-level privileges already cover all columns).
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on structure_settings to app_user;

-- ----------------------------------------------------------------------------
-- 8. Validation performed (disposable postgres:16-alpine containers,
--    torn down after): full chain 0000->0009 (business) + identity
--    0000->0001, superuser (Supabase-style BYPASSRLS) migrator only.
--
--    - sales/payments idempotency_key: duplicate key within the SAME tenant
--      -> unique_violation (23505); the SAME key value across TWO different
--      tenants -> both inserts succeed (not a global unique index).
--    - stock_movements.sale_id composite FK: a sale_id belonging to the
--      OTHER tenant -> foreign_key_violation (23503); a same-tenant sale_id
--      -> succeeds.
--    - stock_movements_source_consistency_chk: source_type='sale' with
--      sale_id NULL -> check_violation; sale_id set with source_type other
--      than 'sale' -> check_violation; a legacy manual movement (source_type
--      ='manual', sale_id NULL) -> still succeeds (not over-blocked).
--    - invoices_paid_le_total_chk: paid_minor = total_minor -> succeeds;
--      paid_minor > total_minor -> check_violation.
--    - invoices_credit_note_of_invoice_fk: nonexistent/cross-tenant target
--      -> foreign_key_violation; same-tenant target -> succeeds.
--    - sales_structure_fy_ticket_idx (partial unique): two draft sales with
--      ticket_number NULL coexist fine; assigning the SAME (fiscal_year,
--      ticket_number) to a second sale in the same structure -> unique_
--      violation.
--    - structure_settings: writable by a member of its own tenant; with the
--      app.structure_id/app.user_id GUCs unset, SELECT across every table
--      touched by this migration (sales, sale_lines, invoices, payments,
--      stock_movements, products, structure_settings) returns 0 rows —
--      default-deny holds on all of them, including the new table.
--    - app_user's grants on `structure_settings` (the new table) are exactly
--      select/insert/update/delete, confirmed via information_schema; every
--      pre-existing touched table's grants are unchanged.
--    - Re-running this file directly (psql -f) against an already-migrated,
--      still-EMPTY database is a clean no-op (every statement's NOTICE
--      confirms "already exists, skipping" / idempotent ALTER); replayed
--      with LEFTOVER test data from a prior manual run, the
--      stock_movements_source_consistency_chk backfill guard (section 4)
--      correctly raises its named exception instead of a raw constraint
--      error, confirming that guard fires for the one re-run case where it
--      matters.
--    - The down script (down/0009_business_layer_sales_billing.down.sql)
--      was applied against the full 0000->0009 chain and verified to fully
--      remove every column/table/index/constraint/grant this migration
--      added, leaving `sales` back to its exact pre-0009 shape (confirmed
--      via `\d sales`) and `structure_settings` dropped entirely; 0009 was
--      then re-applied cleanly on top, confirming the down/up cycle is
--      replayable.
--    - Condensed cumulative exploit suite re-run with zero regression: C1
--      (audit_log direct INSERT by app_user -> permission denied, 42501),
--      H-D (cross-tenant `structures` UPDATE -> 0 rows), H-A (manager
--      DELETEing an owner's membership row -> 0 rows), H-F (manager
--      INSERTing an owner-role invitation -> RLS policy violation).
--
--    Judgment calls / deviations to flag for security-reviewer:
--      - `structure_settings` holds `sod_threshold_minor` (the separation-
--        of-duties control itself) but its RLS, by established convention
--        (same as `tax_settings`), is the generic tenant floor — ANY active
--        member of the tenant can write this row today, not just `owner`.
--        The app layer MUST restrict writes here to `owner` or this table
--        becomes a way to silently disable/raise the SoD threshold. Flagged
--        explicitly in section 2's comment, not coded around here, to stay
--        consistent with how `tax_settings` (equally sensitive) already
--        works — a broader RLS-granularity decision for all such tables is
--        a separate piece of work, not specific to this migration.
--      - `stock:oversell` (the shortage-override permission) has
--        deliberately NO schema representation — enforced entirely at the
--        app layer, audited via the existing `audit_log_append(...)`. See
--        the header comment's "Stock shortage" bullet for why a structure-
--        level toggle was rejected.
--      - `source_type`/`source_id` on `stock_movements` are retained for
--        sources without a dedicated table yet (manual/adjustment); only the
--        'sale' case is retired to a composite-FK column in this migration.
--        Each future source table (e.g. purchase orders) should get the
--        same treatment in its own migration, per the comment in section 4.
-- ============================================================================
