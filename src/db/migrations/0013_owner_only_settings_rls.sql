-- ============================================================================
-- 0013_owner_only_settings_rls.sql (hand-written)
--
-- H4 (security-reviewer, High): `structure_settings` (sod_threshold_minor,
-- max_discount_pct) and `tax_settings` (vat_rate, legal_mentions,
-- invoice_prefix) sat under the generic tenant-floor policy
-- (`tenant_access(structure_id)` for ALL commands) with no role
-- restriction at the DB layer -- any active member, including a
-- `cashier`, could write either row directly (e.g. raise `max_discount_pct`
-- sky-high, or null out `sod_threshold_minor` to disable the
-- separation-of-duties control it's supposed to enforce). This was
-- flagged but explicitly deferred to the app layer in 0009's and 0001's
-- own comments ("the app layer MUST restrict writes ... RLS does not
-- encode that distinction"). Since `manager` ALSO holds `settings:write`
-- (the app-layer permission), relying on the app alone is not enough for
-- a table whose whole purpose is to constrain a role the app layer itself
-- grants broad settings access to -- hence an owner-only RLS policy,
-- preferred by the security-reviewer over app-only gating.
--
-- Read stays open to any active tenant member (both tables are read
-- during normal operation -- e.g. confirmSale reads `tax_settings.vat_rate`
-- and `structure_settings.max_discount_pct`/`sod_threshold_minor` as a
-- cashier). Only INSERT/UPDATE/DELETE are restricted to `owner`.
-- ============================================================================

drop policy if exists structure_settings_tenant_isolation on structure_settings;

create policy structure_settings_select on structure_settings
  for select using (tenant_access(structure_id));

create policy structure_settings_owner_write on structure_settings
  for insert with check (tenant_access(structure_id) and has_role_in_current_structure(array['owner']));

create policy structure_settings_owner_update on structure_settings
  for update
  using (tenant_access(structure_id) and has_role_in_current_structure(array['owner']))
  with check (tenant_access(structure_id) and has_role_in_current_structure(array['owner']));

create policy structure_settings_owner_delete on structure_settings
  for delete using (tenant_access(structure_id) and has_role_in_current_structure(array['owner']));

drop policy if exists tax_settings_tenant_isolation on tax_settings;

create policy tax_settings_select on tax_settings
  for select using (tenant_access(structure_id));

create policy tax_settings_owner_write on tax_settings
  for insert with check (tenant_access(structure_id) and has_role_in_current_structure(array['owner']));

create policy tax_settings_owner_update on tax_settings
  for update
  using (tenant_access(structure_id) and has_role_in_current_structure(array['owner']))
  with check (tenant_access(structure_id) and has_role_in_current_structure(array['owner']));

create policy tax_settings_owner_delete on tax_settings
  for delete using (tenant_access(structure_id) and has_role_in_current_structure(array['owner']));

-- ============================================================================
-- Verification performed (disposable postgres:16-alpine container, chain
-- 0000->0013 + identity 0000->0001, migrator role):
--   - a `manager` actor (has app-layer `settings:write`) attempting
--     `update structure_settings set sod_threshold_minor = null ...` ->
--     rejected by RLS (0 rows affected), confirming the app-layer
--     permission alone no longer suffices to write this table.
--   - an `owner` actor performing the same update -> succeeds.
--   - a `cashier` actor `select`-ing `tax_settings`/`structure_settings`
--     (needed to read vat_rate/max_discount_pct during confirmSale) ->
--     still succeeds (read stays open to any active member).
-- ============================================================================
