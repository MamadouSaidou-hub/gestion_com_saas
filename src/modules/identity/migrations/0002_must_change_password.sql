-- ============================================================================
-- Team/user-creation phase: a teammate created by an owner/manager (see
-- modules/tenancy/create-member.ts) gets an admin-chosen password and must
-- pick their own on first login. This column is the flag that drives that
-- redirect (checked via Better Auth's own session.user, registered as a
-- `user.additionalFields` entry in auth.ts -- see schema.ts's comment on
-- why this project does NOT install Better Auth's admin plugin for this).
--
-- Idempotent (IF NOT EXISTS), same convention as 0000_identity_core.sql.
-- No new grant needed: app_user already has UPDATE on "user" (0000), and
-- this is a plain column addition on an existing, already-granted table.
-- ============================================================================

alter table "user"
  add column if not exists must_change_password boolean not null default false;
