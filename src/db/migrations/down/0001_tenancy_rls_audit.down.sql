-- ============================================================================
-- MANUAL rollback for 0001_tenancy_rls_audit.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0001 (e.g. to re-generate it during development).
-- Idempotent where practical (IF EXISTS everywhere).
-- ============================================================================

-- --- Audit trail -------------------------------------------------------------
drop trigger if exists trg_audit_log_before_insert on audit_log;
drop trigger if exists trg_audit_log_no_update on audit_log;
drop function if exists audit_log_before_insert();
drop function if exists audit_log_no_mutation();
drop function if exists audit_log_append(uuid, text, text, text, text, uuid, jsonb, text);
drop function if exists audit_log_verify(uuid);

drop policy if exists audit_log_select on audit_log;
drop policy if exists audit_log_insert_via_function on audit_log;
alter table audit_log disable row level security;

-- --- Generic tenant tables ----------------------------------------------------
do $$
declare
  t text;
  tenant_tables text[] := array[
    'customers', 'product_categories', 'products', 'suppliers', 'units',
    'warehouses', 'stock_levels', 'stock_movements', 'sale_lines', 'sales',
    'document_counters', 'invoices', 'payment_allocations', 'payments',
    'tax_settings'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('drop policy if exists %I on %I', t || '_tenant_isolation', t);
    execute format('alter table %I disable row level security', t);
  end loop;
end $$;

drop policy if exists currencies_select on currencies;
alter table currencies disable row level security;

-- --- invitations ---------------------------------------------------------------
drop policy if exists invitations_select on invitations;
drop policy if exists invitations_insert on invitations;
drop policy if exists invitations_update on invitations;
drop policy if exists invitations_delete on invitations;
alter table invitations disable row level security;

-- --- memberships -----------------------------------------------------------
drop policy if exists memberships_select on memberships;
drop policy if exists memberships_insert on memberships;
drop policy if exists memberships_update on memberships;
drop policy if exists memberships_delete on memberships;
alter table memberships disable row level security;

-- --- structures --------------------------------------------------------------
drop policy if exists structures_select on structures;
drop policy if exists structures_insert on structures;
drop policy if exists structures_update on structures;
alter table structures disable row level security;

-- --- helper functions ---------------------------------------------------------
drop function if exists tenant_access(uuid);
drop function if exists can_bootstrap_or_manage_memberships(uuid);
drop function if exists has_role_in_current_structure(text[]);
drop function if exists is_member_of_current_structure(uuid);
drop function if exists app_current_user_id();
drop function if exists app_current_structure_id();

-- --- grants ------------------------------------------------------------------
alter default privileges in schema public revoke select, insert, update, delete on tables from app_user;
alter default privileges in schema public revoke usage, select on sequences from app_user;
revoke all privileges on all tables in schema public from app_user;
revoke all privileges on all sequences in schema public from app_user;
revoke usage on schema public from app_user;

-- --- seed data -----------------------------------------------------------------
delete from currencies where code in ('XOF', 'GNF');

-- --- role ----------------------------------------------------------------------
-- Not dropped automatically: app_user may still own open connections / be
-- referenced by GRANTs elsewhere. Drop manually once confirmed unused:
--   DROP ROLE IF EXISTS app_user;

-- pgcrypto is left installed (other extensions/tooling may depend on it).

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
