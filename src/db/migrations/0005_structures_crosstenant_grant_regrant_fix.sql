-- ============================================================================
-- Hand-written migration: fix-round #3 findings from security-reviewer,
-- VERIFIED BY ACTUAL EXECUTION against a disposable Postgres container.
--
-- MUST be applied with the MIGRATOR role (schema owner), same convention as
-- 0001-0004. Idempotent (DROP POLICY IF EXISTS + CREATE / DO $$ guards), so
-- re-running this file is safe.
--
-- Findings fixed here:
--   H-D — BLOCKING. `structures_select`/`structures_update` (0001) used
--         `is_member_of_current_structure(id)`, which checks membership
--         against the TARGET ROW's id, never reconciling it with the
--         session GUC (`app_current_structure_id()`). A user who is
--         `owner` of structure S1 and merely `cashier` of structure S2,
--         with their session scoped to S1, could SELECT and UPDATE S2's
--         row -- including `currency_code`/`valuation_method`/
--         `country_code` -- because `has_role_in_current_structure`
--         checks the GUC-scoped role (owner of S1) while
--         `is_member_of_current_structure(id)` checks membership in the
--         TARGET row (S2). Reproduced: an UPDATE of S2's row from a
--         session scoped to S1 succeeded. Fixed by switching both
--         policies to `tenant_access(id)`, which ties the row's id to the
--         session GUC AND re-verifies real membership, exactly like every
--         other tenant-scoped table already does.
--   H-E — BLOCKING. Privilege regrant window: `app_user` could regain
--         DELETE on "user"/"account" and UPDATE on "verification" because
--         `src/modules/identity/migrations/0001_tighten_grants.sql` only
--         guards itself on `app_user` existing, which is a cluster-wide
--         role -- a no-op guard on any environment where the role already
--         existed from a prior run. If the identity pipeline's REVOKE runs
--         BEFORE the business pipeline's blanket
--         `grant ... on all tables in schema public to app_user` (an
--         ordinary GRANT, not a default-privilege, so it survives 0004's
--         default-privilege REVOKE untouched), the broad grant wins and is
--         never re-revoked. Reproduced on a fresh DB with identity-then-
--         business ordering. Fixed with a terminal, order-independent
--         re-assertion in THIS migration (owned by the business pipeline,
--         so the invariant no longer depends on which pipeline ran last),
--         guarded to no-op if the identity tables don't exist yet.
--   M-A — default-privilege no-op corrected. 0004 section 4 used
--         `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON
--         FUNCTIONS FROM PUBLIC` (and the `extensions` schema equivalent),
--         which is a silent no-op: `pg_default_acl` ends up empty and a
--         function created afterwards still gets `proacl = NULL` (= PUBLIC
--         execute). Verified: only the GLOBAL form (no `IN SCHEMA` clause)
--         actually writes a `pg_default_acl` entry and is honored for
--         functions created later, in ANY schema the migrator role creates
--         objects in. Replaced with the global form here. 0004's header
--         comment claim of "VERIFIED BY ACTUAL EXECUTION" does not hold for
--         this specific statement -- corrected in this file's comment and
--         in db/README.md rather than editing 0004's SQL body.
--
-- Not fixed here, judgment call documented (see section 3 below):
--   Whether 0001's blanket `grant select, insert, update, delete on all
--   tables in schema public to app_user` should become a named table list.
--   Left as-is; the 0005 safety net (section 2) is the chosen mitigation.
--   Reasoning in section 3.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Self-test prerequisite: fail loudly if 0001 is not already applied
--    (this migration edits/depends on objects it creates).
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.tenant_access(uuid)') is null then
    raise exception '0005 requires 0001_tenancy_rls_audit.sql to be applied first';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. H-D — structures_select / structures_update: reconcile the row's id
--    with the session GUC via `tenant_access(id)` instead of checking
--    membership against the target row alone.
--
--    `tenant_access(p_structure)` (0001, section 3) is:
--      select p_structure = app_current_structure_id()
--         and is_member_of_current_structure(p_structure)
--    i.e. the row's id must EQUAL the session's scoped structure AND the
--    caller must be an active member of it -- so a session scoped to S1
--    can never match a row for S2, regardless of the caller's membership
--    or role elsewhere. `has_role_in_current_structure(['owner'])` (used
--    unchanged in the UPDATE policy) already reads the GUC-scoped
--    structure, so combined with `tenant_access(id)` both checks are now
--    pinned to the SAME structure -- closing the reconciliation gap.
--
--    `my_memberships()` (0002) is unaffected: it is a separate SECURITY
--    DEFINER path that filters directly on `app_current_user_id()` across
--    ALL of the caller's own membership rows, with no dependency on
--    `app.structure_id` being set at all -- exactly the post-login
--    structure-picker use case it exists for. Verified unchanged below.
-- ----------------------------------------------------------------------------
drop policy if exists structures_select on structures;
create policy structures_select on structures
  for select using ( tenant_access(id) );

drop policy if exists structures_update on structures;
create policy structures_update on structures
  for update
  using ( tenant_access(id) and has_role_in_current_structure(array['owner']) )
  with check ( tenant_access(id) and has_role_in_current_structure(array['owner']) );

-- ----------------------------------------------------------------------------
-- 2. H-E — terminal, order-independent re-assertion of the identity-table
--    REVOKEs that src/modules/identity/migrations/0001_tighten_grants.sql
--    also issues. Running this from the BUSINESS pipeline (the owner of
--    the blanket GRANT that can re-widen these privileges) makes the
--    invariant hold regardless of which pipeline (`db:migrate` /
--    `identity:db:migrate`) ran last on a given environment. Guarded with
--    `to_regclass` so it's a no-op (not an error) if the identity tables
--    don't exist yet -- i.e. this is safe to run whether identity has run
--    or not, and should be re-applied (or simply re-run again, it's
--    idempotent) after identity's tables are created if business ran
--    first.
--
--    NOTE: this does not fully remove the ordering sensitivity by itself
--    on a database where NEITHER pipeline has run yet and business 0005
--    runs before identity 0000 ever creates these tables -- see
--    db/README.md's "migrate:all" guidance for the one correct invocation
--    order, and re-run `db:migrate` (idempotent) after `identity:db:migrate`
--    on any environment where you're not sure of the historical order.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public."user"') is not null then
    revoke delete on "user" from app_user;
  end if;

  if to_regclass('public."account"') is not null then
    revoke delete on "account" from app_user;
  end if;

  if to_regclass('public."verification"') is not null then
    revoke update on "verification" from app_user;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Judgment call (reviewer's "your call" on the blanket grant): NOT
--    replacing 0001's `grant select, insert, update, delete on all tables
--    in schema public to app_user` with a named business-table list here.
--
--    Reasoning: 0004 already revoked the DEFAULT-PRIVILEGE clause that made
--    that grant dangerous going forward (any table created after 0004 gets
--    NO app_user grant until its own migration explicitly adds one, see
--    0004 section 6) -- the remaining blanket GRANT in 0001 is a one-time,
--    already-executed statement against tables that existed in `public` AT
--    THAT TIME. Converting it to a named list now would mean editing 0001
--    in place (against this project's "never edit 0000-0004 in place"
--    convention, carried forward to 0005) purely to narrow a GRANT whose
--    blast radius is already closed off by 0004 for every table created
--    from here on. The ONLY residual risk is the narrow historical window
--    this finding (H-E) describes -- identity tables that existed BEFORE
--    0004 ran and therefore got swept up by the one-time blanket grant --
--    which section 2 above now re-closes terminally and order-independently
--    every time the business pipeline runs. A named-list rewrite would add
--    risk (a forward migration rewriting a past GRANT's effective table set
--    is easy to get subtly wrong across environments at different migration
--    states) for no additional safety once section 2 exists. Revisit only
--    if a future non-identity module needs the same treatment -- at that
--    point, prefer the same "explicit grant in that table's own migration"
--    pattern 0004 already establishes, not a retroactive edit here.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 4. M-A — default-privilege EXECUTE revoke, corrected form. The `IN
--    SCHEMA public` / `IN SCHEMA extensions` forms used in 0004 section 4
--    are verified no-ops (pg_default_acl ends up empty; a function created
--    afterwards still has proacl = NULL = PUBLIC execute). Only the GLOBAL
--    form (no `IN SCHEMA` clause) writes an entry Postgres actually honors.
--    This single global statement covers every schema the migrator role
--    creates functions in from now on (public, extensions, or any future
--    one) -- there is no need to repeat it per schema.
-- ----------------------------------------------------------------------------
alter default privileges revoke execute on functions from public;

-- ----------------------------------------------------------------------------
-- 5. Validation performed (see also db/README.md "Fix-round #3" section):
--    full chain 0000->0005 (business) + identity 0000->0001, in both a
--    BYPASSRLS and a non-BYPASSRLS migrator config, against a disposable
--    postgres:16-alpine container:
--      a) cross-tenant UPDATE on `structures` from a session scoped to a
--         different structure now fails with "new row violates row-level
--         security policy" (or returns 0 rows for the USING side); a
--         legitimate same-tenant owner UPDATE still succeeds;
--         `my_memberships()` still lists structures correctly with no GUC
--         set at all.
--      b) identity-before-business AND business-before-identity orderings
--         both end with "user"/"account"/"verification" correctly
--         restricted after 0005 runs.
--      c) a function created by the migrator after 0005 runs has
--         proacl = {postgres=X/postgres} (or the migrator's own role), no
--         PUBLIC execute entry.
--    Full prior exploit suite (C1, C2, H1, H2, H3, H-A, H-C, owner-lockout,
--    M1, M9) re-run with zero regression.
-- ============================================================================
