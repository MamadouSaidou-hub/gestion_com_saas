-- ============================================================================
-- Hand-written migration: fixes for the security-reviewer's Critical/High
-- findings against 0001_tenancy_rls_audit.sql / 0002_my_memberships.sql.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001/0002. Idempotent (CREATE OR REPLACE / DROP POLICY IF EXISTS + CREATE /
-- DO $$ guards / CREATE INDEX IF NOT EXISTS), so re-running this file is safe.
--
-- Findings fixed here (see security-reviewer report):
--   C1 — audit_log_append() forged structure/actor identity.
--   C2 — SECURITY DEFINER / helper functions were EXECUTE-able by PUBLIC.
--   H1 — memberships self-escalation / owner lockout / unrestricted bootstrap.
--   H2 — audit chain could silently fork (INVOKER rights + non-unique index).
--   H3 — audit_log_verify() had no tenant/role check (cross-tenant probing).
--   M1 — suppliers missing UNIQUE(structure_id, id) composite-FK anchor.
--   M9 — structures_insert was WITH CHECK (true) (unlimited tenant creation).
--
-- NOT fixed here (flagged, not a straightforward schema change):
--   stock_movements.source_type/source_id is a polymorphic reference with no
--   tenant-safety constraint (it cannot be a composite FK because the target
--   table varies by source_type). Left as an app-layer obligation: the app
--   MUST verify, inside the same transaction, that the referenced
--   source_type/source_id row belongs to the same structure_id before
--   writing a stock_movements row. Flagging again for security-reviewer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Self-test prerequisite: fail loudly, not silently, if 0001/0002 are not
--    already applied (this migration edits objects they create).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.audit_log_append(uuid, text, text, text, text, uuid, jsonb, text)') is null then
    raise exception '0003 requires 0001_tenancy_rls_audit.sql to be applied first';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. C1 — audit_log_append() now re-verifies caller identity against the
--    session context instead of trusting its parameters. p_actor_id /
--    p_actor_role are kept in the signature for call-site compatibility
--    (changing a function's signature would break every existing caller and
--    collide with the 0001 GRANT), but their VALUES are now ignored: the
--    real actor_id comes from app_current_user_id() and the real actor_role
--    is looked up in `memberships` for that user + structure, never trusted
--    from the caller.
-- ----------------------------------------------------------------------------
create or replace function audit_log_append(
  p_structure_id uuid,
  p_actor_id text,    -- IGNORED as of 0003: kept only for signature stability, see comment above.
  p_actor_role text,  -- IGNORED as of 0003: kept only for signature stability, see comment above.
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
  v_id          bigint;
  v_actor_id    text;
  v_actor_role  text;
begin
  -- Tenant check: the structure the caller claims to act on MUST be the one
  -- their session GUC is scoped to, AND they must be an active member of it.
  -- This closes C1: a forged/mismatched p_structure_id now raises instead of
  -- silently writing an audit row for another tenant.
  if p_structure_id is distinct from app_current_structure_id() then
    raise exception 'audit_log_append: structure_id % does not match session context', p_structure_id;
  end if;

  if not is_member_of_current_structure(p_structure_id) then
    raise exception 'audit_log_append: caller is not an active member of structure %', p_structure_id;
  end if;

  -- Actor identity: always the real session user, never the parameter.
  v_actor_id := app_current_user_id();
  if v_actor_id is null then
    raise exception 'audit_log_append: no authenticated user in session context';
  end if;

  -- Actor role: re-derived from the real membership row, never the parameter.
  select m.role::text into v_actor_role
  from memberships m
  where m.structure_id = p_structure_id
    and m.user_id = v_actor_id
    and m.status = 'active';

  if v_actor_role is null then
    raise exception 'audit_log_append: no active membership role found for actor % on structure %', v_actor_id, p_structure_id;
  end if;

  insert into audit_log (
    structure_id, actor_id, actor_role, action, target_type, target_id,
    payload, request_id, prev_hash, entry_hash, seq
  ) values (
    p_structure_id, v_actor_id, v_actor_role, p_action, p_target_type, p_target_id,
    coalesce(p_payload, '{}'::jsonb), p_request_id,
    decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 0
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. H3 — audit_log_verify() now requires the caller to be scoped to AND
--    hold a reader role (owner/accountant/auditor) on the tenant being
--    verified, closing the cross-tenant metadata-leak / DoS probe.
-- ----------------------------------------------------------------------------
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

  return null; -- intact
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. H2 — audit_log_before_insert() made SECURITY DEFINER so it reliably
--    sees the true last entry for the tenant regardless of the calling
--    role's SELECT visibility under audit_log's RLS policy (which is
--    restricted to owner/accountant/auditor) -- otherwise a cashier's INSERT
--    (via audit_log_append, itself SECURITY DEFINER but that does not change
--    what THIS trigger function sees unless it is independently SECURITY
--    DEFINER too) could see prev_hash = NULL and silently restart the chain
--    at seq = 1, forking it.
-- ----------------------------------------------------------------------------
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
    v_prev := decode(repeat('00', 32), 'hex'); -- genesis, per tenant
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

-- Hard-error on a fork instead of a silent duplicate: seq must be unique per
-- tenant. Drop the old non-unique index first (same name reused would error
-- on type change, so we rename to `_uq` and keep the drop idempotent).
drop index if exists audit_log_structure_seq_idx;
create unique index if not exists audit_log_structure_seq_uq on audit_log (structure_id, seq);

-- ----------------------------------------------------------------------------
-- 4. H1 / M9 — memberships: no self-escalation, no acting on your own row,
--    no owner lockout; structures: no unrestricted tenant creation.
-- ----------------------------------------------------------------------------

-- 4a. can_bootstrap_or_manage_memberships() loses its "zero members" branch.
-- Tenant bootstrap now goes exclusively through create_structure_with_owner()
-- below (SECURITY DEFINER). This function is now equivalent to "is an
-- active owner/manager of p_structure" -- kept as a named helper (rather than
-- inlined) so the memberships_insert policy below does not need to change.
create or replace function can_bootstrap_or_manage_memberships(p_structure uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.structure_id = p_structure
      and m.user_id = app_current_user_id()
      and m.role in ('owner', 'manager')
      and m.status = 'active'
  )
$$;

-- 4b. memberships_update / memberships_delete: can't act on your own row
-- (no self-promotion, no self-demotion-to-lockout-dodge via this path), and
-- WITH CHECK blocks setting role = 'owner' unless the acting user is already
-- an owner of that structure (no manager -> owner self-or-peer escalation).
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

-- 4c. Owner-lockout trigger: independent of the policies above (defense in
-- depth -- e.g. also protects against a future policy regression), raises
-- if an UPDATE/DELETE would leave a structure with zero active owners.
-- SECURITY DEFINER so the lockout check reliably sees every owner row for
-- the structure regardless of the acting role's RLS visibility (same
-- rationale as audit_log_before_insert above).
create or replace function memberships_owner_lockout_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining_owners bigint;
begin
  if old.role = 'owner' and old.status = 'active' then
    if (tg_op = 'DELETE') or (new.role <> 'owner' or new.status <> 'active') then
      select count(*) into v_remaining_owners
      from memberships
      where structure_id = old.structure_id
        and role = 'owner'
        and status = 'active'
        and user_id <> old.user_id;

      if v_remaining_owners = 0 then
        raise exception 'memberships: cannot remove/demote the last active owner of structure %', old.structure_id;
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

drop trigger if exists trg_memberships_owner_lockout on memberships;
create trigger trg_memberships_owner_lockout
  before update or delete on memberships
  for each row execute function memberships_owner_lockout_guard();

-- 4d. structures_insert: no more unrestricted tenant creation. Direct INSERT
-- by app_user is denied outright (FORCE RLS + a policy that never passes);
-- the only path to create a structure is create_structure_with_owner()
-- below. NOTE (same documented assumption as 0001's helper functions): this
-- requires the SECURITY DEFINER function's OWNER role to carry BYPASSRLS --
-- true automatically for Supabase's `postgres`/project-owner role, must be
-- granted explicitly by a superuser otherwise (see db/README.md).
drop policy if exists structures_insert on structures;
create policy structures_insert on structures
  for insert with check (false);

-- 4e. create_structure_with_owner(): the ONLY supported way to create a new
-- tenant. Creates the structure row and its first (owner) membership row in
-- one atomic statement/transaction, so a structure can never exist with zero
-- members (closing the M9/H1 "unrestricted bootstrap" + the db/README.md
-- claim -- now corrected below -- that an emptied structure becomes
-- permanently inaccessible: it was never true that app code "must, in the
-- same transaction" do this manually; that manual two-step bootstrap is what
-- let the zero-members policy branch be abused. It's now enforced by this
-- single function instead of by convention).
create or replace function create_structure_with_owner(
  p_name text,
  p_country_code text,
  p_currency_code text,
  p_owner_user_id text,
  p_valuation_method valuation_method default 'cump'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_structure_id uuid;
begin
  -- The owner being created MUST be the authenticated session user -- this
  -- function cannot be used to hand another, unrelated user_id ownership of
  -- a brand new structure.
  if p_owner_user_id is distinct from app_current_user_id() then
    raise exception 'create_structure_with_owner: owner must be the authenticated session user';
  end if;

  if p_owner_user_id is null then
    raise exception 'create_structure_with_owner: no authenticated user in session context';
  end if;

  insert into structures (name, country_code, currency_code, valuation_method)
  values (p_name, p_country_code, p_currency_code, p_valuation_method)
  returning id into v_structure_id;

  insert into memberships (user_id, structure_id, role, status)
  values (p_owner_user_id, v_structure_id, 'owner', 'active');

  return v_structure_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. M1 — suppliers needs the same composite-FK anchor as every other parent
--    table, before purchasing tables reference it.
-- ----------------------------------------------------------------------------
do $$
begin
  alter table suppliers add constraint suppliers_structure_id_id_idx unique (structure_id, id);
exception
  when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- 6. C2 — revoke EXECUTE from PUBLIC on every SECURITY DEFINER / helper
--    function defined in 0001/0002/0003, then explicitly grant back only
--    what app_user needs. Without this, Supabase's Data API (PostgREST),
--    if ever enabled on this schema, would let `anon`/`authenticated` call
--    every one of these through PUBLIC's default EXECUTE grant.
--
--    IMPORTANT: is_member_of_current_structure / has_role_in_current_structure
--    / can_bootstrap_or_manage_memberships are evaluated AS app_user inside
--    RLS policy expressions -- revoking PUBLIC without re-granting app_user
--    here would lock app_user out of its OWN tenant tables (every RLS policy
--    referencing them would fail with "permission denied for function"
--    instead of normally allow/deny). 0001 never granted these three
--    explicitly; they only worked because of the PUBLIC default this
--    migration now closes. Grant them explicitly below.
-- ----------------------------------------------------------------------------

-- 0001 functions.
revoke execute on function app_current_structure_id() from public;
revoke execute on function app_current_user_id() from public;
revoke execute on function is_member_of_current_structure(uuid) from public;
revoke execute on function has_role_in_current_structure(text[]) from public;
revoke execute on function can_bootstrap_or_manage_memberships(uuid) from public;
revoke execute on function tenant_access(uuid) from public;
revoke execute on function audit_log_before_insert() from public;
revoke execute on function audit_log_no_mutation() from public;
revoke execute on function audit_log_append(uuid, text, text, text, text, uuid, jsonb, text) from public;
revoke execute on function audit_log_verify(uuid) from public;

-- 0002 function.
revoke execute on function my_memberships() from public;

-- 0003 functions.
revoke execute on function memberships_owner_lockout_guard() from public;
revoke execute on function create_structure_with_owner(text, text, text, text, valuation_method) from public;

-- Explicit app_user grants -- everything app_user actually needs to call
-- directly or transitively through an RLS policy expression. Trigger
-- functions (audit_log_before_insert, audit_log_no_mutation,
-- memberships_owner_lockout_guard) are invoked by the trigger mechanism, not
-- by direct EXECUTE from the DML-issuing role, so app_user does NOT need an
-- EXECUTE grant on those three -- revoking PUBLIC above is enough to close
-- C2 for them without needing a matching grant.
grant execute on function app_current_structure_id() to app_user;
grant execute on function app_current_user_id() to app_user;
grant execute on function is_member_of_current_structure(uuid) to app_user;
grant execute on function has_role_in_current_structure(text[]) to app_user;
grant execute on function can_bootstrap_or_manage_memberships(uuid) to app_user;
grant execute on function tenant_access(uuid) to app_user;
grant execute on function audit_log_append(uuid, text, text, text, text, uuid, jsonb, text) to app_user;
grant execute on function audit_log_verify(uuid) to app_user;
grant execute on function my_memberships() to app_user;
grant execute on function create_structure_with_owner(text, text, text, text, valuation_method) to app_user;
