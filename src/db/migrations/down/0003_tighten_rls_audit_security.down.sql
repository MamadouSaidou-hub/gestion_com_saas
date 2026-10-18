-- ============================================================================
-- MANUAL rollback for 0003_tighten_rls_audit_security.sql.
--
-- drizzle-kit's migration runner is forward-only; this script is NOT applied
-- automatically by `npm run db:migrate`. Run it by hand with the MIGRATOR
-- role if you need to undo 0003. Restores the exact pre-0003 definitions
-- from 0001_tenancy_rls_audit.sql / 0002_my_memberships.sql. Idempotent
-- where practical (IF EXISTS everywhere).
--
-- WARNING: this reintroduces every finding 0003 fixed (C1/C2/H1/H2/H3/M1/M9).
-- Only run this during development to re-generate 0003, never against a
-- tenant-carrying environment.
-- ============================================================================

-- --- 6. Grants: restore PUBLIC EXECUTE (the implicit default these
--     functions had before 0003's REVOKE), drop the 0003-only grants. ------
grant execute on function app_current_structure_id() to public;
grant execute on function app_current_user_id() to public;
grant execute on function is_member_of_current_structure(uuid) to public;
grant execute on function has_role_in_current_structure(text[]) to public;
grant execute on function can_bootstrap_or_manage_memberships(uuid) to public;
grant execute on function tenant_access(uuid) to public;
grant execute on function audit_log_before_insert() to public;
grant execute on function audit_log_no_mutation() to public;
grant execute on function audit_log_append(uuid, text, text, text, text, uuid, jsonb, text) to public;
grant execute on function audit_log_verify(uuid) to public;
grant execute on function my_memberships() to public;

-- --- 5. suppliers composite-FK anchor ---------------------------------------
alter table suppliers drop constraint if exists suppliers_structure_id_id_idx;

-- --- 4e/4d. create_structure_with_owner + structures_insert -----------------
drop function if exists create_structure_with_owner(text, text, text, text, valuation_method);

drop policy if exists structures_insert on structures;
create policy structures_insert on structures
  for insert with check ( true );

-- --- 4c. owner-lockout trigger -----------------------------------------------
drop trigger if exists trg_memberships_owner_lockout on memberships;
drop function if exists memberships_owner_lockout_guard();

-- --- 4b. memberships_update / memberships_delete: restore originals --------
drop policy if exists memberships_update on memberships;
create policy memberships_update on memberships
  for update
  using ( tenant_access(structure_id) and has_role_in_current_structure(array['owner', 'manager']) )
  with check ( tenant_access(structure_id) and has_role_in_current_structure(array['owner', 'manager']) );

drop policy if exists memberships_delete on memberships;
create policy memberships_delete on memberships
  for delete using ( tenant_access(structure_id) and has_role_in_current_structure(array['owner', 'manager']) );

-- --- 4a. can_bootstrap_or_manage_memberships: restore the zero-members branch
create or replace function can_bootstrap_or_manage_memberships(p_structure uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    not exists (select 1 from memberships m where m.structure_id = p_structure)
    or exists (
      select 1 from memberships m
      where m.structure_id = p_structure
        and m.user_id = app_current_user_id()
        and m.role in ('owner', 'manager')
        and m.status = 'active'
    )
$$;

-- --- 3. audit_log_before_insert + unique index -------------------------------
drop index if exists audit_log_structure_seq_uq;
create index if not exists audit_log_structure_seq_idx on audit_log (structure_id, seq);

create or replace function audit_log_before_insert()
returns trigger
language plpgsql
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

-- --- 2. audit_log_verify: restore original (no tenant/role check) -----------
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

-- --- 1. audit_log_append: restore original (no identity check) --------------
create or replace function audit_log_append(
  p_structure_id uuid,
  p_actor_id text,
  p_actor_role text,
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_payload jsonb,
  p_request_id text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into audit_log (
    structure_id, actor_id, actor_role, action, target_type, target_id,
    payload, request_id, prev_hash, entry_hash, seq
  ) values (
    p_structure_id, p_actor_id, p_actor_role, p_action, p_target_type, p_target_id,
    coalesce(p_payload, '{}'::jsonb), p_request_id,
    decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 0
  )
  returning id into v_id;

  return v_id;
end;
$$;

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
