-- ============================================================================
-- MANUAL rollback for 0004_owner_lockdown_bypassrls_assert.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0004. Restores the exact pre-0004 definitions
-- from 0003_tighten_rls_audit_security.sql.
--
-- WARNING: this reintroduces H-A (manager can demote/delete an existing
-- owner row) and H-C (hard crash without BYPASSRLS, since FORCE is restored
-- on structures/memberships), moves pgcrypto back into `public` with
-- PUBLIC EXECUTE, and restores the schema-wide table default-privilege (so
-- any future table in `public`, including a future identity table, is
-- implicitly granted full CRUD again). Only run this during development,
-- never against a tenant-carrying environment.
-- ============================================================================

-- --- 6. restore the schema-wide table/sequence default privilege ----------
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_user;
alter default privileges in schema public
  grant usage, select on sequences to app_user;

-- --- 5. pgcrypto: move back to public, restore PUBLIC EXECUTE -------------
do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto'
      and n.nspname = 'extensions'
  ) then
    execute 'alter extension pgcrypto set schema public';
  end if;
end $$;

-- NOTE: this intentionally does NOT re-grant EXECUTE on pgcrypto's functions
-- to PUBLIC -- restoring that implicit default (vs. an explicit grant) isn't
-- meaningfully reversible one statement at a time once pgcrypto is back in
-- `public`; PostgreSQL's own CREATE EXTENSION-time default already applies.
-- Drop the schema only if we created it and it's now empty.
do $$
begin
  if not exists (select 1 from pg_extension where extnamespace = (select oid from pg_namespace where nspname = 'extensions'))
     and not exists (select 1 from pg_proc where pronamespace = (select oid from pg_namespace where nspname = 'extensions'))
  then
    drop schema if exists extensions;
  end if;
end $$;

-- --- 4. default privileges: restore PUBLIC-executable default for future
--     functions in schema public (the pre-0004 PostgreSQL default). --------
alter default privileges in schema public
  grant execute on functions to public;

-- --- 3. memberships_update / memberships_delete: restore 0003 originals ---
drop policy if exists memberships_update on memberships;
create policy memberships_update on memberships
  for update
  using (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and user_id <> app_current_user_id()
  )
  with check (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and user_id <> app_current_user_id()
    and (role <> 'owner' or has_role_in_current_structure(array['owner']))
  );

drop policy if exists memberships_delete on memberships;
create policy memberships_delete on memberships
  for delete using (
    tenant_access(structure_id)
    and has_role_in_current_structure(array['owner', 'manager'])
    and user_id <> app_current_user_id()
  );

-- --- 2. restore FORCE ROW LEVEL SECURITY on structures/memberships --------
alter table structures force row level security;
alter table memberships force row level security;

-- --- audit_log_before_insert / audit_log_verify: restore 0003 definitions
--     (digest() unqualified, search_path = public only -- pgcrypto is back
--     in public by this point in the rollback, so this resolves again). --
create or replace function audit_log_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev bytea;
  v_seq  bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.structure_id::text, 0));

  select entry_hash, seq into v_prev, v_seq
  from audit_log
  where structure_id = new.structure_id
  order by id desc
  limit 1;

  if v_prev is null then
    v_prev := decode(repeat('00', 32), 'hex');
    v_seq := 0;
  end if;

  new.created_at := coalesce(new.created_at, now());
  new.seq := v_seq + 1;
  new.prev_hash := v_prev;
  new.entry_hash := digest(
    v_prev
    || convert_to(new.structure_id::text, 'UTF8')
    || convert_to(coalesce(new.actor_id, ''), 'UTF8')
    || convert_to(new.action, 'UTF8')
    || convert_to(new.target_type, 'UTF8')
    || convert_to(coalesce(new.target_id::text, ''), 'UTF8')
    || convert_to(new.payload::text, 'UTF8')
    || convert_to(new.created_at::text, 'UTF8'),
    'sha256'
  );
  return new;
end;
$$;

create or replace function audit_log_verify(p_structure_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_prev     bytea := decode(repeat('00', 32), 'hex');
  v_seq      bigint := 0;
  v_computed bytea;
begin
  if p_structure_id is distinct from app_current_structure_id() then
    raise exception 'audit_log_verify: structure_id % does not match session context', p_structure_id;
  end if;

  if not has_role_in_current_structure(array['owner', 'accountant', 'auditor']) then
    raise exception 'audit_log_verify: caller lacks a reader role on structure %', p_structure_id;
  end if;

  for r in
    select * from audit_log where structure_id = p_structure_id order by id asc
  loop
    v_seq := v_seq + 1;
    v_computed := digest(
      v_prev
      || convert_to(r.structure_id::text, 'UTF8')
      || convert_to(coalesce(r.actor_id, ''), 'UTF8')
      || convert_to(r.action, 'UTF8')
      || convert_to(r.target_type, 'UTF8')
      || convert_to(coalesce(r.target_id::text, ''), 'UTF8')
      || convert_to(r.payload::text, 'UTF8')
      || convert_to(r.created_at::text, 'UTF8'),
      'sha256'
    );

    if r.prev_hash <> v_prev or r.entry_hash <> v_computed or r.seq <> v_seq then
      return r.id;
    end if;

    v_prev := r.entry_hash;
  end loop;

  return null;
end;
$$;

-- --- 1. BYPASSRLS assertion: nothing to roll back (DO $$ block, no object
--     created). ------------------------------------------------------------

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
