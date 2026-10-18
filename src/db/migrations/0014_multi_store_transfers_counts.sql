-- ============================================================================
-- 0014_multi_store_transfers_counts.sql (hand-written)
--
-- Architect plan approved, product decisions FINAL (2026-10-18):
--   - Multi-store is ACTIVE: several stores, a store selector, a "gerant"
--     scoped to exactly ONE store, inter-store transfers.
--   - A gerant is NOT a new role: it is a `manager` membership that carries a
--     `warehouse_id`. One store per member (not several), per user decision.
--   - Store maps onto the EXISTING `warehouses` table, not a new `stores`
--     table -- stock_movements/stock_levels/sales already composite-FK onto
--     it; a parallel table would force rewriting the ledger + CUMP
--     projection for no benefit.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0013. Idempotent (ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS /
-- DO $$ guards around constraints with no native IF NOT EXISTS form), so
-- re-running this file is safe.
--
-- Sections:
--   0. Prerequisite + BYPASSRLS assertions.
--   1. warehouses: code / kind / is_active / address / phone (store vs depot).
--   2. memberships.warehouse_id (one store per member; owner must stay
--      unscoped) + composite FK + CHECK.
--   3. app_scoped_warehouse_id() -- the store-scoping SECURITY DEFINER
--      helper, derived from the SAME membership row as the role (zero
--      forgeable-GUC surface), with the 0005 default-privilege proof.
--   4. payments.warehouse_id (backfilled from sales, then from the tenant's
--      default store).
--   5. document_counters: doc_type gains 'transfer'.
--   6. New tables: stock_transfers / stock_transfer_lines, stock_counts /
--      stock_count_lines.
--   7. stock_movements: transfer_id / stock_count_id / supplier_delivery_id
--      composite-FK columns + the exclusive-arc rewrite of
--      stock_movements_source_consistency_chk (closes debt 2r).
--   8. RLS policy rewrites: add the store-scope predicate to
--      stock_movements / stock_levels / sales / payments (existing
--      generic-floor tables) and to the two new header tables
--      (stock_transfers, stock_counts). Floor-only RLS for the two new line
--      tables (stock_transfer_lines, stock_count_lines) -- same
--      floor/ceiling split already established for sale_lines/invoices/
--      payment_allocations, see db/README.md.
--   9. Grants for every new table (0004's default-privilege REVOKE still
--      applies: no implicit grant on a new table).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Prerequisites + BYPASSRLS assertion (same invariant as 0004/0009: every
--    FORCE-RLS table this migration touches, and the new SECURITY DEFINER
--    helper added in section 3, depend on the migrator role carrying
--    BYPASSRLS to read across membership visibility without recursing).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.has_role_in_current_structure(text[])') is null then
    raise exception '0014 requires 0001_tenancy_rls_audit.sql to be applied first (missing has_role_in_current_structure)';
  end if;

  if not exists (
    select 1 from pg_policies where tablename = 'tax_settings' and policyname = 'tax_settings_owner_write'
  ) then
    raise exception '0014 requires 0013_owner_only_settings_rls.sql to be applied first';
  end if;
end $$;

do $$
declare
  v_bypassrls boolean;
begin
  select rolbypassrls into v_bypassrls from pg_roles where rolname = current_user;

  if not coalesce(v_bypassrls, false) then
    raise exception
      '0014: migrator role "%" does not have BYPASSRLS. See db/README.md '
      '("Judgment call to flag to security-reviewer") and 0004''s identical '
      'assertion -- app_scoped_warehouse_id() (section 3) is a new SECURITY '
      'DEFINER reader of the FORCE-RLS `memberships` table and depends on '
      'the same invariant. Grant it out-of-band as a superuser: '
      'ALTER ROLE % BYPASSRLS;',
      current_user, current_user;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. warehouses -- store vs depot. A depot is a non-selling stock location:
--    the POS warehouse selector only offers kind = 'store'; stock
--    movements/counts/transfers accept either.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'warehouse_kind') then
    create type warehouse_kind as enum ('store', 'depot');
  end if;
end $$;

alter table warehouses add column if not exists code text;
alter table warehouses add column if not exists kind warehouse_kind not null default 'store';
alter table warehouses add column if not exists is_active boolean not null default true;
alter table warehouses add column if not exists address text;
alter table warehouses add column if not exists phone text; -- E.164, clear text, tenant-scoped (D7) -- same convention as suppliers/customers.phone

-- Backfill `code` for any pre-existing row (dev/test fixtures): derive a
-- short, tenant-unique code from the row's own id -- a uuid is unique on its
-- own, so this cannot collide, even across tenants. New rows must supply
-- their own human-chosen code going forward (app layer validates
-- uniqueness via the index below before insert).
update warehouses
set code = upper(substr(replace(id::text, '-', ''), 1, 10))
where code is null;

do $$
begin
  if exists (select 1 from warehouses where code is null or code = '') then
    raise exception '0014: warehouses has rows with NULL/empty code after backfill -- investigate before re-running this migration';
  end if;
end $$;

alter table warehouses alter column code set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'warehouses_code_nonempty_chk'
  ) then
    alter table warehouses
      add constraint warehouses_code_nonempty_chk
      check (length(btrim(code)) > 0);
  end if;
end $$;

create unique index if not exists warehouses_structure_code_idx on warehouses (structure_id, code);
create index if not exists warehouses_structure_kind_idx on warehouses (structure_id, kind);

-- ----------------------------------------------------------------------------
-- 2. memberships.warehouse_id -- a "gerant" is a `manager` whose membership
--    carries a store (one store per member, NULL = all-stores scope). An
--    `owner` must never be locked inside one store: enforced by a CHECK, not
--    just app-layer discipline.
-- ----------------------------------------------------------------------------
alter table memberships add column if not exists warehouse_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memberships_warehouse_fk'
  ) then
    alter table memberships
      add constraint memberships_warehouse_fk
      foreign key (structure_id, warehouse_id) references warehouses (structure_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'memberships_owner_no_warehouse_chk'
  ) then
    alter table memberships
      add constraint memberships_owner_no_warehouse_chk
      check (role <> 'owner' or warehouse_id is null);
  end if;
end $$;

-- Used both by the FK above and by app_scoped_warehouse_id()'s lookup below.
create index if not exists memberships_structure_warehouse_idx on memberships (structure_id, warehouse_id);

-- ----------------------------------------------------------------------------
-- 3. app_scoped_warehouse_id() -- the store-scoping predicate's ONLY input.
--
--    Deliberately NOT a third session GUC (`app.warehouse_id`): a GUC the
--    app sets is a forgeable value an attacker-controlled request could try
--    to smuggle. Instead this reads `memberships.warehouse_id` for
--    (app_current_user_id(), app_current_structure_id()) -- the exact same
--    row `has_role_in_current_structure()` already re-verifies the role
--    against -- so there is zero new spoofing surface: whatever already
--    stops a forged role also stops a forged store scope, because both come
--    from the same authoritative row.
--
--    NULL return means "all-stores scope" (an owner, or any membership with
--    warehouse_id left NULL) -- this is only reachable at all because
--    tenant_access(structure_id) already re-verifies a real active
--    membership row exists; a request with no valid membership never reaches
--    the warehouse-scope OR-branch, tenant_access's AND short-circuits it.
-- ----------------------------------------------------------------------------
create or replace function app_scoped_warehouse_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.warehouse_id
  from memberships m
  where m.structure_id = app_current_structure_id()
    and m.user_id = app_current_user_id()
    and m.status = 'active'
$$;

-- Proof that 0005's GLOBAL `alter default privileges revoke execute on
-- functions from public` (fix-round #3, see db/README.md entry 2c) actually
-- covers a function created here, in 0014, four migrations later -- checked
-- BEFORE the explicit revoke below, so this assertion is not masked by it.
do $$
begin
  if has_function_privilege('public', 'app_scoped_warehouse_id()', 'execute') then
    raise exception
      '0014: app_scoped_warehouse_id() is EXECUTE-able by PUBLIC immediately '
      'after CREATE FUNCTION -- 0005''s default-privilege REVOKE did not '
      'take effect for this migrator role. Investigate before relying on '
      'the explicit per-function REVOKE below as the only safety net.';
  end if;
end $$;

-- Explicit, belt-and-suspenders per-function REVOKE/GRANT (same convention
-- as every other SECURITY DEFINER helper in this schema, e.g.
-- tenant_access/audit_log_append in 0001): only app_user may call this.
revoke execute on function app_scoped_warehouse_id() from public;
grant execute on function app_scoped_warehouse_id() to app_user;

-- ----------------------------------------------------------------------------
-- 4. payments.warehouse_id -- treasury-per-store needs it, and it puts an
--    RLS floor on the most sensitive money path. Backfilled from the sale
--    it was collected for; orphan payments (no sale_id, or a sale_id that
--    did not resolve) fall back to the structure's default store, then to
--    any store belonging to that structure if no default is flagged.
-- ----------------------------------------------------------------------------
alter table payments add column if not exists warehouse_id uuid;

update payments p
set warehouse_id = s.warehouse_id
from sales s
where p.warehouse_id is null
  and p.sale_id = s.id
  and p.structure_id = s.structure_id;

update payments p
set warehouse_id = w.id
from warehouses w
where p.warehouse_id is null
  and w.structure_id = p.structure_id
  and w.is_default = true;

update payments p
set warehouse_id = w.id
from (
  select structure_id, id,
         row_number() over (partition by structure_id order by created_at) as rn
  from warehouses
) w
where p.warehouse_id is null
  and w.structure_id = p.structure_id
  and w.rn = 1;

do $$
declare
  v_remaining int;
begin
  select count(*) into v_remaining from payments where warehouse_id is null;

  if v_remaining > 0 then
    raise notice
      '0014: % payments row(s) could not be backfilled with a warehouse_id '
      '(their structure has zero warehouses) -- column left NULLable for '
      'those rows. Under the new RLS predicate (section 8) they remain '
      'visible to unscoped (owner) members only, invisible to any '
      'store-scoped gerant, until backfilled by hand.', v_remaining;
  else
    if not exists (
      select 1 from information_schema.columns
      where table_name = 'payments' and column_name = 'warehouse_id' and is_nullable = 'NO'
    ) then
      alter table payments alter column warehouse_id set not null;
    end if;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_warehouse_fk'
  ) then
    alter table payments
      add constraint payments_warehouse_fk
      foreign key (structure_id, warehouse_id) references warehouses (structure_id, id);
  end if;
end $$;

create index if not exists payments_structure_warehouse_idx on payments (structure_id, warehouse_id);

-- ----------------------------------------------------------------------------
-- 5. document_counters -- transfers get their own gapless counter, same
--    mechanism as tickets (0009) and invoices (0000).
-- ----------------------------------------------------------------------------
alter type document_type add value if not exists 'transfer';

-- ----------------------------------------------------------------------------
-- 6.a stock_transfers (header) -- inter-store movement in transit between
--     two warehouses (store or depot). Visible from BOTH sides (section 8).
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'stock_transfer_status') then
    create type stock_transfer_status as enum ('in_transit', 'received', 'cancelled');
  end if;
end $$;

create table if not exists stock_transfers (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  reference text not null, -- allocated via document_counters, doc_type = 'transfer'
  fiscal_year integer not null,
  from_warehouse_id uuid not null,
  to_warehouse_id uuid not null,
  status stock_transfer_status not null default 'in_transit',
  currency_code text not null references currencies (code),
  created_by text not null, -- Better Auth user id
  created_at timestamptz not null default now(),
  received_by text,
  received_at timestamptz,
  cancelled_by text,
  cancelled_at timestamptz,
  cancel_reason text,
  -- PWA retry-queue de-duplication key, same money-correctness mechanism as
  -- sales.idempotency_key (0009) / payments.idempotency_key (0009).
  idempotency_key text not null,
  -- sha256 fingerprint of the request payload, same H1 defense as
  -- sales.request_fingerprint (0012): an idempotency-key replay with a
  -- DIFFERENT payload (different lines/destination) must be refused, not
  -- silently treated as the original transfer.
  request_fingerprint text not null
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_structure_id_id_key') then
    alter table stock_transfers add constraint stock_transfers_structure_id_id_key unique (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_structure_idempotency_key_key') then
    alter table stock_transfers add constraint stock_transfers_structure_idempotency_key_key
      unique (structure_id, idempotency_key);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_from_warehouse_fk') then
    alter table stock_transfers add constraint stock_transfers_from_warehouse_fk
      foreign key (structure_id, from_warehouse_id) references warehouses (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_to_warehouse_fk') then
    alter table stock_transfers add constraint stock_transfers_to_warehouse_fk
      foreign key (structure_id, to_warehouse_id) references warehouses (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_distinct_warehouses_chk') then
    alter table stock_transfers add constraint stock_transfers_distinct_warehouses_chk
      check (from_warehouse_id <> to_warehouse_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_received_consistency_chk') then
    alter table stock_transfers add constraint stock_transfers_received_consistency_chk
      check ((status = 'received') = (received_at is not null))
      ;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_received_by_consistency_chk') then
    alter table stock_transfers add constraint stock_transfers_received_by_consistency_chk
      check ((status = 'received') = (received_by is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_cancelled_consistency_chk') then
    alter table stock_transfers add constraint stock_transfers_cancelled_consistency_chk
      check ((status = 'cancelled') = (cancelled_at is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_cancelled_by_consistency_chk') then
    alter table stock_transfers add constraint stock_transfers_cancelled_by_consistency_chk
      check ((status = 'cancelled') = (cancelled_by is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_cancel_reason_consistency_chk') then
    alter table stock_transfers add constraint stock_transfers_cancel_reason_consistency_chk
      check (status = 'cancelled' or cancel_reason is null);
  end if;
end $$;

create index if not exists stock_transfers_structure_id_idx on stock_transfers (structure_id);
create index if not exists stock_transfers_from_warehouse_idx on stock_transfers (structure_id, from_warehouse_id);
create index if not exists stock_transfers_to_warehouse_idx on stock_transfers (structure_id, to_warehouse_id);
create index if not exists stock_transfers_status_idx on stock_transfers (structure_id, status);
create unique index if not exists stock_transfers_structure_fy_reference_idx
  on stock_transfers (structure_id, fiscal_year, reference);

-- ----------------------------------------------------------------------------
-- 6.b stock_transfer_lines (detail) -- unit_cost_minor is the CUMP snapshot
--     AT DEPARTURE (stock_levels' moving average at the time the transfer
--     left the origin warehouse), so the receiving warehouse's own CUMP
--     projection has a cost to post the incoming movement at.
-- ----------------------------------------------------------------------------
create table if not exists stock_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  transfer_id uuid not null,
  product_id uuid not null,
  quantity numeric(18, 4) not null,
  unit_cost_minor bigint not null,
  line_no smallint not null default 1
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_transfer_lines_transfer_fk') then
    alter table stock_transfer_lines add constraint stock_transfer_lines_transfer_fk
      foreign key (structure_id, transfer_id) references stock_transfers (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfer_lines_product_fk') then
    alter table stock_transfer_lines add constraint stock_transfer_lines_product_fk
      foreign key (structure_id, product_id) references products (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfer_lines_structure_transfer_line_no_key') then
    alter table stock_transfer_lines add constraint stock_transfer_lines_structure_transfer_line_no_key
      unique (structure_id, transfer_id, line_no);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfer_lines_quantity_positive_chk') then
    alter table stock_transfer_lines add constraint stock_transfer_lines_quantity_positive_chk
      check (quantity > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_transfer_lines_unit_cost_nonneg_chk') then
    alter table stock_transfer_lines add constraint stock_transfer_lines_unit_cost_nonneg_chk
      check (unit_cost_minor >= 0);
  end if;
end $$;

create index if not exists stock_transfer_lines_structure_id_idx on stock_transfer_lines (structure_id);
create index if not exists stock_transfer_lines_transfer_idx on stock_transfer_lines (structure_id, transfer_id);
create index if not exists stock_transfer_lines_product_idx on stock_transfer_lines (structure_id, product_id);

-- ----------------------------------------------------------------------------
-- 6.c stock_counts (header) + stock_count_lines (detail) -- tables only in
--     this migration, per the plan: the use cases (open/validate/cancel a
--     physical count) ship in a later phase.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'stock_count_status') then
    create type stock_count_status as enum ('draft', 'validated', 'cancelled');
  end if;
end $$;

create table if not exists stock_counts (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  warehouse_id uuid not null,
  status stock_count_status not null default 'draft',
  created_by text not null,
  created_at timestamptz not null default now(),
  validated_by text,
  validated_at timestamptz,
  cancelled_by text,
  cancelled_at timestamptz,
  idempotency_key text not null
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_counts_structure_id_id_key') then
    alter table stock_counts add constraint stock_counts_structure_id_id_key unique (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_counts_structure_idempotency_key_key') then
    alter table stock_counts add constraint stock_counts_structure_idempotency_key_key
      unique (structure_id, idempotency_key);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_counts_warehouse_fk') then
    alter table stock_counts add constraint stock_counts_warehouse_fk
      foreign key (structure_id, warehouse_id) references warehouses (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_counts_validated_consistency_chk') then
    alter table stock_counts add constraint stock_counts_validated_consistency_chk
      check ((status = 'validated') = (validated_at is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_counts_validated_by_consistency_chk') then
    alter table stock_counts add constraint stock_counts_validated_by_consistency_chk
      check ((status = 'validated') = (validated_by is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_counts_cancelled_consistency_chk') then
    alter table stock_counts add constraint stock_counts_cancelled_consistency_chk
      check ((status = 'cancelled') = (cancelled_at is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_counts_cancelled_by_consistency_chk') then
    alter table stock_counts add constraint stock_counts_cancelled_by_consistency_chk
      check ((status = 'cancelled') = (cancelled_by is not null));
  end if;
end $$;

create index if not exists stock_counts_structure_id_idx on stock_counts (structure_id);
create index if not exists stock_counts_warehouse_idx on stock_counts (structure_id, warehouse_id);
create index if not exists stock_counts_status_idx on stock_counts (structure_id, status);

create table if not exists stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  stock_count_id uuid not null,
  product_id uuid not null,
  theoretical_qty numeric(18, 4) not null, -- snapshotted at open, from stock_levels
  counted_qty numeric(18, 4),              -- NULL until counted
  variance_qty numeric(18, 4),             -- app-maintained: counted_qty - theoretical_qty
  unit_cost_minor bigint not null default 0,
  variance_value_minor bigint              -- app-maintained: variance_qty * unit_cost_minor
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_count_lines_stock_count_fk') then
    alter table stock_count_lines add constraint stock_count_lines_stock_count_fk
      foreign key (structure_id, stock_count_id) references stock_counts (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_count_lines_product_fk') then
    alter table stock_count_lines add constraint stock_count_lines_product_fk
      foreign key (structure_id, product_id) references products (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_count_lines_structure_count_product_key') then
    alter table stock_count_lines add constraint stock_count_lines_structure_count_product_key
      unique (structure_id, stock_count_id, product_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_count_lines_theoretical_qty_nonneg_chk') then
    alter table stock_count_lines add constraint stock_count_lines_theoretical_qty_nonneg_chk
      check (theoretical_qty >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_count_lines_counted_qty_nonneg_chk') then
    alter table stock_count_lines add constraint stock_count_lines_counted_qty_nonneg_chk
      check (counted_qty is null or counted_qty >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_count_lines_unit_cost_nonneg_chk') then
    alter table stock_count_lines add constraint stock_count_lines_unit_cost_nonneg_chk
      check (unit_cost_minor >= 0);
  end if;
end $$;

create index if not exists stock_count_lines_structure_id_idx on stock_count_lines (structure_id);
create index if not exists stock_count_lines_stock_count_idx on stock_count_lines (structure_id, stock_count_id);
create index if not exists stock_count_lines_product_idx on stock_count_lines (structure_id, product_id);

-- ----------------------------------------------------------------------------
-- 7. stock_movements -- add the three composite-FK columns in ONE shot
--    (transfer_id, stock_count_id now FK'd to tables created in section 6;
--    supplier_delivery_id gets the COLUMN now, with its FK deferred to the
--    migration that ships the supplier_deliveries table -- it must still be
--    one of the exclusive-arc slots today), then replace
--    stock_movements_source_consistency_chk with a true exclusive-arc
--    constraint. This closes debt 2r (db/README.md) in full: every source
--    of a stock movement now has either a dedicated composite-FK column or
--    a narrowed, exhaustively-enumerated source_type.
-- ----------------------------------------------------------------------------
alter table stock_movements add column if not exists transfer_id uuid;
alter table stock_movements add column if not exists stock_count_id uuid;
alter table stock_movements add column if not exists supplier_delivery_id uuid; -- no FK yet: supplier_deliveries ships in a later phase

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_transfer_fk') then
    alter table stock_movements add constraint stock_movements_transfer_fk
      foreign key (structure_id, transfer_id) references stock_transfers (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'stock_movements_stock_count_fk') then
    alter table stock_movements add constraint stock_movements_stock_count_fk
      foreign key (structure_id, stock_count_id) references stock_counts (structure_id, id);
  end if;
end $$;

create index if not exists stock_movements_transfer_idx on stock_movements (structure_id, transfer_id);
create index if not exists stock_movements_stock_count_idx on stock_movements (structure_id, stock_count_id);
create index if not exists stock_movements_supplier_delivery_idx on stock_movements (structure_id, supplier_delivery_id);

-- Guard: fail loudly, not with a raw constraint-violation, if any existing
-- row would not satisfy the new exclusive-arc constraint (cannot happen on
-- the empty/0009-consistent data this environment has today -- the OLD
-- check already enforced exactly one of {sale_id, source_type} on every
-- row, and the three new columns are freshly NULL everywhere).
do $$
declare
  v_bad bigint;
begin
  select id into v_bad
  from stock_movements
  where num_nonnulls(sale_id, transfer_id, stock_count_id, supplier_delivery_id, source_type) <> 1
     or (source_id is not null and source_type is null)
     or (source_type is not null and source_type not in ('manual', 'adjustment', 'opening'))
  limit 1;

  if v_bad is not null then
    raise exception
      '0014: stock_movements.id = % does not satisfy the new exclusive-arc '
      'constraint (exactly one of sale_id/transfer_id/stock_count_id/'
      'supplier_delivery_id/source_type, source_type in manual/adjustment/'
      'opening) -- reclassify or backfill it before re-running this migration.',
      v_bad;
  end if;
end $$;

alter table stock_movements drop constraint if exists stock_movements_source_consistency_chk;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stock_movements_exclusive_arc_chk'
  ) then
    alter table stock_movements
      add constraint stock_movements_exclusive_arc_chk
      check (
        num_nonnulls(sale_id, transfer_id, stock_count_id, supplier_delivery_id, source_type) = 1
        -- source_id is the legacy pair's polymorphic id: it may only be set
        -- alongside a source_type (it is NOT required when source_type IS
        -- set -- 'manual'/'adjustment'/'opening' may have no natural id).
        and (source_id is null or source_type is not null)
        and (source_type is null or source_type in ('manual', 'adjustment', 'opening'))
      );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8. RLS policy rewrites -- the store-scoping predicate.
--
--    `app_scoped_warehouse_id() is null or <col> = app_scoped_warehouse_id()`
--    added, ANDed with the existing tenant floor, on every table that
--    carries a `warehouse_id` and is read on a store-scoped dashboard:
--    stock_movements, stock_levels, sales, payments (existing generic-floor
--    policies, dropped and recreated below) and the two new header tables,
--    stock_transfers (OR across BOTH sides -- a transfer is legitimately
--    visible from its origin AND its destination gerant) and stock_counts.
--
--    Deliberately NOT denormalized onto sale_lines / invoices /
--    payment_allocations / stock_transfer_lines / stock_count_lines: those
--    are only ever reached by joining an already-filtered parent row, and a
--    correlated EXISTS-against-the-parent per row in a line table's policy
--    would wreck the dashboard aggregates that scan these tables directly
--    (top products, 30-day windows, ...). Store scope for the line tables is
--    APP-CEILING ONLY -- this is a deliberate floor/ceiling split, not an
--    oversight, consistent with how sale_lines/invoices/payment_allocations
--    already work under the existing tenant-floor-only convention. See
--    db/README.md.
-- ----------------------------------------------------------------------------

drop policy if exists stock_movements_tenant_isolation on stock_movements;
create policy stock_movements_tenant_isolation on stock_movements
  for all
  using (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  )
  with check (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  );

drop policy if exists stock_levels_tenant_isolation on stock_levels;
create policy stock_levels_tenant_isolation on stock_levels
  for all
  using (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  )
  with check (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  );

drop policy if exists sales_tenant_isolation on sales;
create policy sales_tenant_isolation on sales
  for all
  using (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  )
  with check (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  );

drop policy if exists payments_tenant_isolation on payments;
create policy payments_tenant_isolation on payments
  for all
  using (
    tenant_access(structure_id)
    and (
      app_scoped_warehouse_id() is null
      or warehouse_id = app_scoped_warehouse_id()
    )
  )
  with check (
    tenant_access(structure_id)
    and (
      app_scoped_warehouse_id() is null
      or warehouse_id = app_scoped_warehouse_id()
    )
  );

alter table stock_transfers enable row level security;
alter table stock_transfers force row level security;

create policy stock_transfers_tenant_isolation on stock_transfers
  for all
  using (
    tenant_access(structure_id)
    and (
      app_scoped_warehouse_id() is null
      or from_warehouse_id = app_scoped_warehouse_id()
      or to_warehouse_id = app_scoped_warehouse_id()
    )
  )
  with check (
    tenant_access(structure_id)
    and (
      app_scoped_warehouse_id() is null
      or from_warehouse_id = app_scoped_warehouse_id()
      or to_warehouse_id = app_scoped_warehouse_id()
    )
  );

alter table stock_counts enable row level security;
alter table stock_counts force row level security;

create policy stock_counts_tenant_isolation on stock_counts
  for all
  using (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  )
  with check (
    tenant_access(structure_id)
    and (app_scoped_warehouse_id() is null or warehouse_id = app_scoped_warehouse_id())
  );

-- Floor-only RLS for the two new line tables (see header comment above).
alter table stock_transfer_lines enable row level security;
alter table stock_transfer_lines force row level security;

create policy stock_transfer_lines_tenant_isolation on stock_transfer_lines
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

alter table stock_count_lines enable row level security;
alter table stock_count_lines force row level security;

create policy stock_count_lines_tenant_isolation on stock_count_lines
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

-- ----------------------------------------------------------------------------
-- 9. Grants -- mandatory for every new table (0004 revoked the schema-wide
--    default-privilege grant; each new table's own migration must GRANT
--    app_user explicitly). Existing tables that only gained COLUMNS
--    (warehouses, memberships, payments, stock_movements) need no new
--    GRANT -- table-level privileges already cover all columns.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on stock_transfers to app_user;
grant select, insert, update, delete on stock_transfer_lines to app_user;
grant select, insert, update, delete on stock_counts to app_user;
grant select, insert, update, delete on stock_count_lines to app_user;

-- ============================================================================
-- Validation performed (disposable postgres:16-alpine container, torn down
-- after): full chain 0000->0014 (business) + identity 0000->0001, superuser
-- (Supabase-style BYPASSRLS) migrator, then app_user under RLS.
--
--   - A `manager` membership with warehouse_id = store A sees exactly the
--     sales/stock_movements/stock_levels/payments rows scoped to store A
--     (count = 1 on all four tables with one row seeded per store); the
--     symmetric manager scoped to store B sees only store B's rows; an
--     `owner` (warehouse_id NULL) sees both (count = 2 on all four).
--   - `memberships_owner_no_warehouse_chk` fires on both an INSERT and an
--     UPDATE that would give an `owner` row a non-NULL `warehouse_id`.
--   - `stock_movements_exclusive_arc_chk`: zero-source and two-source
--     (sale_id + source_type together) rows are both rejected with
--     `check_violation`; sale_id-only, transfer_id-only, stock_count_id-only,
--     legacy source_type='manual' (no source_id) and legacy
--     source_type='adjustment' (with source_id) each insert cleanly.
--   - A `stock_transfers` row from store A to store B is visible under RLS
--     to BOTH the store-A-scoped manager and the store-B-scoped manager
--     (count = 1 for each), confirming the OR-across-both-sides predicate.
--   - `stock_transfers_structure_idempotency_key_key`: the SAME
--     idempotency_key within the SAME tenant -> unique_violation; the SAME
--     key value across TWO different tenants -> both inserts succeed.
--   - `has_function_privilege('public', 'app_scoped_warehouse_id()',
--     'execute')` returns false (checked BEFORE this migration's own
--     explicit REVOKE runs, proving 0005's global default-privilege REVOKE
--     already covers it); `has_function_privilege('app_user', ...)` returns
--     true.
--   - Condensed cumulative exploit suite re-run with zero regression: C1
--     (app_user direct INSERT on audit_log -> permission denied, 42501),
--     H-D (cross-tenant `structures` UPDATE from a scoped session -> 0
--     rows), H-A (manager DELETE on an owner's membership row -> 0 rows),
--     H-F (manager INSERT of an owner-role invitation -> RLS policy
--     violation), H-I (manager DELETE on an owner's invitation -> 0 rows).
--   - Down script (down/0014_multi_store_transfers_counts.down.sql) applied
--     against the full 0000->0014 chain and replayed (up -> down -> up):
--     every new table/column/constraint/policy/grant this migration added
--     was confirmed gone after down, and 0014 re-applied cleanly on top.
--     One expected, DOCUMENTED side effect of the down script's destructive
--     column drops (same nature as 0009's own down script dropping
--     idempotency_key/ticket_number data): `memberships.warehouse_id` and
--     `stock_movements.transfer_id/stock_count_id` data existing before the
--     down script ran does not survive it (the columns are dropped, then
--     re-added as fresh NULL columns on re-up) -- store-scope assignments
--     and transfer/count linkage made before a rollback must be re-entered
--     afterward. Not an issue for a schema-only replay with no real tenant
--     data, which is the only supported use of any down script in this
--     project (see each down script's own header warning).
-- ============================================================================
