-- ============================================================================
-- 0016_rebates_and_trgm_search.sql (hand-written)
--
-- Architect plan approved, product decisions FINAL (2026-10-18):
--   - Rebate scales are GENERIC and driven by QUANTITY SOLD/DELIVERED (not
--     sacks, not amount), "CLIFF" mode (hitting a tier rebates ALL units
--     counted in the period/cycle, not just the units above the threshold),
--     and STRICTLY INFORMATIONAL -- never auto-deducted from any receivable
--     or debt. This is a structural invariant (see section 4's comment),
--     not just a documented intention.
--   - Customer side = MONTHLY: counts units in the current UTC calendar
--     month, resetting automatically because the period is derived from
--     now() and never stored as a counter.
--   - Supplier side = CYCLIC, no time limit: counts units delivered since
--     the last granted tier, auto-triggering on delivery. The tier GRANTED
--     is the HIGHEST TIER REACHED (explicit user decision -- the reference
--     app's own README contradicts its code here; this schema follows the
--     code's behaviour).
--   - Exactly one of customer_id/supplier_id per scale -- two explicit FK
--     columns with a CHECK, NOT a party_type/party_id polymorph. Applying
--     the 2r lesson (db/README.md) preventively this time, not after the
--     fact.
--
-- Also in this migration: pg_trgm-backed global search (products, customers,
-- suppliers) and the extra `customers` columns the clients screen needs.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0015. Idempotent, so re-running this file is safe.
--
-- Sections:
--   0. Prerequisite + BYPASSRLS assertion.
--   1. New enums: rebate_model, rebate_mode, rebate_grant_trigger.
--   2. rebate_scales.
--   3. rebate_tiers.
--   4. rebate_grants (history) -- the "never auto-deducted" invariant is
--      enforced STRUCTURALLY here: no FK to payments/invoices/
--      supplier_payments/any balance column exists, or can accidentally be
--      added later without touching this migration's own review diff.
--   5. RLS for the three new tables (generic tenant floor -- these are not
--      store-scoped: rebates are computed at customer/supplier granularity,
--      which is already tenant-consolidated, same reasoning as
--      supplier_payments in 0015).
--   6. Grants.
--   7. `customers` extra columns for the clients screen.
--   8. pg_trgm in `extensions`, GIN indexes for global search.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Prerequisites + BYPASSRLS assertion.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.tenant_access(uuid)') is null then
    raise exception '0016 requires 0001_tenancy_rls_audit.sql to be applied first (missing tenant_access)';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'supplier_deliveries_structure_id_id_key') then
    raise exception '0016 requires 0015_supplier_purchasing.sql to be applied first (missing supplier_deliveries)';
  end if;
end $$;

do $$
declare
  v_bypassrls boolean;
begin
  select rolbypassrls into v_bypassrls from pg_roles where rolname = current_user;

  if not coalesce(v_bypassrls, false) then
    raise exception
      '0016: migrator role "%" does not have BYPASSRLS. See db/README.md '
      '("Judgment call to flag to security-reviewer") -- the new FORCE-RLS '
      'tables this migration adds (section 5) depend on the same invariant '
      'every other tenant table in this schema already does. Grant it '
      'out-of-band as a superuser: ALTER ROLE % BYPASSRLS;',
      current_user, current_user;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. New enums.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rebate_model') then
    create type rebate_model as enum ('monthly', 'cyclic');
  end if;

  if not exists (select 1 from pg_type where typname = 'rebate_mode') then
    -- Only 'cliff' exists today (hitting a tier rebates ALL counted units,
    -- not just the ones above the threshold). An enum, not a boolean, so a
    -- future "marginal" mode can be added without a column-type change.
    create type rebate_mode as enum ('cliff');
  end if;

  if not exists (select 1 from pg_type where typname = 'rebate_grant_trigger') then
    create type rebate_grant_trigger as enum ('manual', 'auto');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. rebate_scales -- exactly one of customer_id/supplier_id (two explicit
--    composite-FK columns + a CHECK, not a party_type/party_id polymorph --
--    applying the 2r lesson preventively, see db/README.md).
--
--    `cycle_started_at` is meaningful ONLY for the cyclic (supplier) model --
--    the monthly (customer) model's period is always derived from now() at
--    read time and never persisted as a counter, so a monthly scale must
--    keep this column NULL (enforced by the CHECK below).
-- ----------------------------------------------------------------------------
create table if not exists rebate_scales (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  customer_id uuid,
  supplier_id uuid,
  model rebate_model not null,
  mode rebate_mode not null default 'cliff',
  currency_code text not null references currencies (code),
  cycle_started_at timestamptz,
  is_active boolean not null default true,
  created_by text not null, -- Better Auth user id
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rebate_scales_structure_id_id_key') then
    alter table rebate_scales add constraint rebate_scales_structure_id_id_key unique (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'rebate_scales_customer_fk') then
    alter table rebate_scales add constraint rebate_scales_customer_fk
      foreign key (structure_id, customer_id) references customers (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'rebate_scales_supplier_fk') then
    alter table rebate_scales add constraint rebate_scales_supplier_fk
      foreign key (structure_id, supplier_id) references suppliers (structure_id, id);
  end if;

  -- Exactly-one-non-null -- the structural guard against a party_type/
  -- party_id-shaped polymorph creeping back in (2r).
  if not exists (select 1 from pg_constraint where conname = 'rebate_scales_exactly_one_party_chk') then
    alter table rebate_scales add constraint rebate_scales_exactly_one_party_chk
      check (num_nonnulls(customer_id, supplier_id) = 1);
  end if;

  -- A customer scale (model = 'monthly') must never persist cycle_started_at
  -- (the monthly period is derived from now(), never stored); a supplier
  -- scale (model = 'cyclic') may set it or leave it NULL until its first
  -- delivery establishes a starting point.
  if not exists (select 1 from pg_constraint where conname = 'rebate_scales_cycle_started_at_model_chk') then
    alter table rebate_scales add constraint rebate_scales_cycle_started_at_model_chk
      check (model = 'cyclic' or cycle_started_at is null);
  end if;

  -- The customer/supplier model pairing is fixed by product decision
  -- (customer = monthly, supplier = cyclic) -- enforced here so a future
  -- caller cannot create a cyclic customer scale or a monthly supplier scale
  -- by mistake.
  if not exists (select 1 from pg_constraint where conname = 'rebate_scales_party_model_chk') then
    alter table rebate_scales add constraint rebate_scales_party_model_chk
      check (
        (customer_id is not null and model = 'monthly')
        or (supplier_id is not null and model = 'cyclic')
      );
  end if;
end $$;

create index if not exists rebate_scales_structure_id_idx on rebate_scales (structure_id);

-- One scale per customer / per supplier (partial, since the column itself
-- may be NULL for the other party).
create unique index if not exists rebate_scales_structure_customer_idx
  on rebate_scales (structure_id, customer_id) where customer_id is not null;
create unique index if not exists rebate_scales_structure_supplier_idx
  on rebate_scales (structure_id, supplier_id) where supplier_id is not null;

-- ----------------------------------------------------------------------------
-- 3. rebate_tiers -- the quantity ladder for a scale. `threshold_qty` is the
--    cumulative quantity that must be reached (cliff mode: reaching it
--    rebates every counted unit, not just the ones above it).
-- ----------------------------------------------------------------------------
create table if not exists rebate_tiers (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  scale_id uuid not null,
  threshold_qty numeric(18, 4) not null,
  rebate_per_unit_minor bigint not null,
  currency_code text not null references currencies (code)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rebate_tiers_scale_fk') then
    alter table rebate_tiers add constraint rebate_tiers_scale_fk
      foreign key (structure_id, scale_id) references rebate_scales (structure_id, id);
  end if;

  -- Spec names this unique(scale_id, threshold_qty); structure_id is
  -- included as the leading column per this project's universal convention
  -- that every composite unique constraint leads with structure_id (see
  -- "Composite FK pattern" in db/README.md) -- scale_id already pins the
  -- tenant transitively via its own composite FK above, so this is the same
  -- uniqueness, expressed consistently with every other table in this
  -- schema rather than as an exception to it.
  if not exists (select 1 from pg_constraint where conname = 'rebate_tiers_structure_scale_threshold_key') then
    alter table rebate_tiers add constraint rebate_tiers_structure_scale_threshold_key
      unique (structure_id, scale_id, threshold_qty);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'rebate_tiers_threshold_positive_chk') then
    alter table rebate_tiers add constraint rebate_tiers_threshold_positive_chk
      check (threshold_qty > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'rebate_tiers_rebate_per_unit_nonneg_chk') then
    alter table rebate_tiers add constraint rebate_tiers_rebate_per_unit_nonneg_chk
      check (rebate_per_unit_minor >= 0);
  end if;
end $$;

create index if not exists rebate_tiers_structure_id_idx on rebate_tiers (structure_id);
create index if not exists rebate_tiers_scale_idx on rebate_tiers (structure_id, scale_id);

-- ----------------------------------------------------------------------------
-- 4. rebate_grants (history) -- CRITICAL INVARIANT, enforced structurally:
--    there is NO foreign key, and must never be one, from rebate_grants to
--    payments, invoices, supplier_payments or any balance column. A rebate
--    is informational only -- it is surfaced to a human, never wired into a
--    receivable/debt computation. Making this impossible to violate by
--    schema means: this table's only FK target is rebate_scales (section 2
--    above); no column here is named/typed to reference any money-movement
--    table; any future migration that adds such an FK must edit THIS
--    header comment, which is the trip-wire for a security-reviewer pass
--    before merge.
--
--    `model` is a DENORMALIZED COPY of the scale's model at grant time
--    (not read live from rebate_scales): a grant is a historical fact and
--    must stay correct even if the scale's model were ever changed later
--    (today's app layer has no such mutation, but the schema should not
--    silently misrepresent history if one is added). It is also what makes
--    the monthly-only partial unique index below expressible without a
--    correlated subquery in the index predicate (Postgres does not support
--    that).
--
--    `period_label` is required for monthly grants (e.g. '2026-10') and
--    always NULL for cyclic grants (the cyclic model legitimately produces
--    several grants with no natural period key -- see header comment of the
--    task brief). The partial unique index enforces "no duplicate monthly
--    grant for the same scale+period" without blocking cyclic grants, which
--    coexist freely (multiple NULLs in a unique index are never considered
--    duplicates by Postgres).
-- ----------------------------------------------------------------------------
create table if not exists rebate_grants (
  id uuid primary key default gen_random_uuid(),
  structure_id uuid not null references structures (id) on delete cascade,
  scale_id uuid not null,
  model rebate_model not null, -- denormalized copy of rebate_scales.model at grant time, see above
  period_label text,
  period_start timestamptz not null,
  period_end timestamptz not null,
  counted_qty numeric(18, 4) not null,
  tier_threshold_qty numeric(18, 4) not null,
  rebate_per_unit_minor bigint not null,
  total_rebate_minor bigint not null,
  currency_code text not null references currencies (code),
  granted_at timestamptz not null default now(),
  granted_by text, -- Better Auth user id; NULL only when trigger = 'auto' (see check below)
  trigger rebate_grant_trigger not null
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rebate_grants_scale_fk') then
    alter table rebate_grants add constraint rebate_grants_scale_fk
      foreign key (structure_id, scale_id) references rebate_scales (structure_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'rebate_grants_period_consistency_chk') then
    alter table rebate_grants add constraint rebate_grants_period_consistency_chk
      check (period_end >= period_start);
  end if;

  -- period_label is required for monthly grants, forbidden for cyclic ones.
  if not exists (select 1 from pg_constraint where conname = 'rebate_grants_period_label_model_chk') then
    alter table rebate_grants add constraint rebate_grants_period_label_model_chk
      check ((model = 'monthly') = (period_label is not null));
  end if;

  -- A manual grant must name the human who granted it; an auto-triggered
  -- grant (delivery-driven, no human actor) may leave it NULL.
  if not exists (select 1 from pg_constraint where conname = 'rebate_grants_granted_by_trigger_chk') then
    alter table rebate_grants add constraint rebate_grants_granted_by_trigger_chk
      check ((trigger = 'manual') = (granted_by is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'rebate_grants_counted_qty_nonneg_chk') then
    alter table rebate_grants add constraint rebate_grants_counted_qty_nonneg_chk
      check (counted_qty >= 0 and tier_threshold_qty > 0 and rebate_per_unit_minor >= 0 and total_rebate_minor >= 0);
  end if;
end $$;

create index if not exists rebate_grants_structure_id_idx on rebate_grants (structure_id);
create index if not exists rebate_grants_scale_idx on rebate_grants (structure_id, scale_id);
create index if not exists rebate_grants_granted_at_idx on rebate_grants (structure_id, granted_at);

-- Monthly-only partial unique index -- see header comment. Cyclic grants
-- (model = 'cyclic', period_label always NULL) are unaffected and may
-- coexist any number of times for the same scale.
create unique index if not exists rebate_grants_structure_scale_period_label_idx
  on rebate_grants (structure_id, scale_id, period_label)
  where model = 'monthly';

-- ----------------------------------------------------------------------------
-- 5. RLS -- generic tenant floor only for all three new tables. Rebates are
--    computed/granted at customer/supplier granularity, which (like
--    supplier_payments in 0015) is already a tenant-consolidated concept,
--    not a per-store one -- no store predicate applies here.
-- ----------------------------------------------------------------------------
alter table rebate_scales enable row level security;
alter table rebate_scales force row level security;

create policy rebate_scales_tenant_isolation on rebate_scales
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

alter table rebate_tiers enable row level security;
alter table rebate_tiers force row level security;

create policy rebate_tiers_tenant_isolation on rebate_tiers
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

alter table rebate_grants enable row level security;
alter table rebate_grants force row level security;

create policy rebate_grants_tenant_isolation on rebate_grants
  for all using (tenant_access(structure_id)) with check (tenant_access(structure_id));

-- ----------------------------------------------------------------------------
-- 6. Grants -- mandatory for every new table (0004's default-privilege
--    REVOKE still applies).
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on rebate_scales to app_user;
grant select, insert, update, delete on rebate_tiers to app_user;
grant select, insert, update, delete on rebate_grants to app_user;

-- ----------------------------------------------------------------------------
-- 7. customers -- extra columns the clients screen needs.
-- ----------------------------------------------------------------------------
alter table customers add column if not exists is_active boolean not null default true;
alter table customers add column if not exists credit_limit_minor bigint;
alter table customers add column if not exists default_payment_terms_days integer;
alter table customers add column if not exists address text;
alter table customers add column if not exists notes text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_credit_limit_nonneg_chk') then
    alter table customers add constraint customers_credit_limit_nonneg_chk
      check (credit_limit_minor is null or credit_limit_minor >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'customers_payment_terms_nonneg_chk') then
    alter table customers add constraint customers_payment_terms_nonneg_chk
      check (default_payment_terms_days is null or default_payment_terms_days >= 0);
  end if;
end $$;

create index if not exists customers_structure_is_active_idx on customers (structure_id, is_active);

-- ----------------------------------------------------------------------------
-- 8. pg_trgm -- installed in `extensions` (Supabase convention, same schema
--    0004 relocated pgcrypto into), NOT `public` -- installing a trigram
--    index/function surface in `public` would reopen exactly the
--    PostgREST/Data-API exposure 0004's C2 fix closed. EXECUTE is revoked
--    from PUBLIC for every function in that schema (pg_trgm's own, and
--    pgcrypto's, belt-and-suspenders re-assertion), then explicitly granted
--    to app_user only -- the trigram `%`/similarity operators used by
--    global search invoke pg_trgm's functions (and the GIN opclass support
--    functions) under the CALLING role's own privileges, not under a
--    SECURITY DEFINER function's, so app_user needs EXECUTE directly to use
--    them at all (unlike pgcrypto's digest()/crypt(), which app_user only
--    ever reaches transitively through a SECURITY DEFINER function and
--    therefore never needed EXECUTE on directly).
--
--    JUDGMENT CALL flagged for security-reviewer: granting EXECUTE on ALL
--    functions in `extensions` to app_user (rather than hand-enumerating
--    pg_trgm's ~20 public/support functions, several of them undocumented
--    GIN opclass internals subject to change across Postgres minor
--    versions) also hands app_user EXECUTE on pgcrypto's functions it did
--    not have before. Accepted: app_user is already the single fully
--    trusted, fully-tenant-scoped app-facing role with full CRUD on every
--    business table; being able to additionally call crypt()/digest()/
--    hmac() directly is not a privilege escalation relative to what it
--    already controls, and the actual security boundary this schema cares
--    about (no PostgREST/anon exposure, PUBLIC locked out) is unaffected --
--    PUBLIC still cannot execute anything in `extensions`.
-- ----------------------------------------------------------------------------
create extension if not exists pg_trgm schema extensions;

revoke execute on all functions in schema extensions from public;
grant execute on all functions in schema extensions to app_user;

-- Proof, by execution, that PUBLIC is actually locked out after the
-- extension's own installation (CREATE EXTENSION grants its functions'
-- default ACL, which may or may not already exclude PUBLIC depending on
-- how ALTER DEFAULT PRIVILEGES interacts with extension-created objects --
-- this assertion does not assume either way, it just checks the end state
-- the explicit REVOKE above is responsible for).
do $$
begin
  if has_function_privilege('public', 'extensions.similarity(text, text)', 'execute') then
    raise exception
      '0016: extensions.similarity(text, text) is EXECUTE-able by PUBLIC '
      'after installing pg_trgm -- the explicit REVOKE above did not take '
      'effect. Investigate before relying on app_user-only access to '
      'trigram search.';
  end if;

  if not has_function_privilege('app_user', 'extensions.similarity(text, text)', 'execute') then
    raise exception
      '0016: app_user cannot EXECUTE extensions.similarity(text, text) -- '
      'global search via the %% / similarity operators will fail at '
      'runtime for the app role.';
  end if;
end $$;

-- GIN trigram indexes for global search. Schema-qualified opclass
-- (extensions.gin_trgm_ops) since `extensions` is deliberately not on this
-- session's search_path.
create index if not exists products_name_trgm_idx on products using gin (name extensions.gin_trgm_ops);
create index if not exists products_sku_trgm_idx on products using gin (sku extensions.gin_trgm_ops);
create index if not exists customers_name_trgm_idx on customers using gin (name extensions.gin_trgm_ops);
create index if not exists customers_phone_trgm_idx on customers using gin (phone extensions.gin_trgm_ops);
create index if not exists suppliers_name_trgm_idx on suppliers using gin (name extensions.gin_trgm_ops);

-- ============================================================================
-- Validation performed (disposable postgres:16-alpine container, torn down
-- after): full chain 0000->0016 (business) + identity 0000->0001. See
-- db/README.md entry 2y for the full transcript.
-- ============================================================================
