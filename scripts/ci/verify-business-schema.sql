-- ============================================================================
-- CI-only sanity check for the migration-cycle job
-- (.github/workflows/ci.yml, job "migration-cycle").
--
-- WHY THIS EXISTS (read before deleting):
-- Running `npm run migrate:all` a second time after the full down-migration
-- sweep was found, BY ACTUALLY EXECUTING THIS, to report "Migrations
-- complete." / exit 0 while the business schema stayed EMPTY -- drizzle-kit's
-- own bookkeeping (`drizzle.__drizzle_migrations`, a schema/table it creates
-- itself on first run, outside of and untouched by this project's
-- hand-written down/*.sql scripts) still listed every migration as "already
-- applied" by hash, even though the down scripts had just DROPped every
-- table those migrations created. drizzle-kit's migrate() trusts its own
-- journal, not the live schema, so it silently no-ops instead of
-- re-running anything. A bare "exit code 0" migration job would have passed
-- CI while leaving the throwaway DB with only the identity tables.
--
-- This is exactly the class of bug this whole pipeline exists to catch
-- (see CLAUDE.md task context / db/README.md's fix-round log) -- it was
-- found BY building this job, not fixed here: this script only makes the
-- CI job fail loudly and correctly instead of silently passing. The real
-- fix (most likely: the down/0000 script should also
-- `drop schema if exists drizzle cascade;`, or migrate.ts should refuse to
-- report success when 0 new migrations ran against an unexpectedly empty
-- schema) is schema/migration-runner work that belongs to db-supabase +
-- security-reviewer, per CLAUDE.md's workflow for anything touching a
-- migration -- NOT silently patched into a down script from the devops
-- side. Flagged in the CI build report; tracked, not fixed, here.
--
-- What this checks: a representative set of tables from EVERY business
-- schema area (tenancy, catalog, inventory, sales, billing, audit) plus
-- Better Auth's identity tables actually exist in `public` after the
-- second `migrate:all`. Not an exhaustive column/constraint check -- just
-- enough canaries that "the business schema silently failed to come back"
-- cannot pass unnoticed again.
-- ============================================================================
do $$
declare
  missing text[];
begin
  select array_agg(t)
    into missing
  from unnest(array[
    -- tenancy.ts
    'structures', 'memberships', 'invitations', 'currencies',
    -- catalog.ts
    'products', 'product_categories', 'units', 'warehouses', 'suppliers', 'customers',
    -- inventory.ts
    'stock_movements', 'stock_levels',
    -- sales.ts
    'sales', 'sale_lines',
    -- billing.ts
    'tax_settings', 'document_counters', 'invoices', 'payments', 'payment_allocations',
    -- audit.ts
    'audit_log',
    -- 0009/0013 additions
    'structure_settings',
    -- Better Auth identity tables (src/modules/identity)
    'user', 'session', 'account', 'verification'
  ]) as t
  where not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = t
  );

  if missing is not null then
    raise exception
      'migration-cycle verification failed: % expected table(s) missing after re-apply: %',
      array_length(missing, 1), missing;
  end if;

  raise notice 'migration-cycle verification passed: all expected tables present after re-apply.';
end $$;
