import { pgTable, text, boolean, timestamp, uniqueIndex, index, integer, bigint } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Better Auth's own tables (user / session / account / verification).
//
// These are DELIBERATELY NOT part of src/db/schema/* (the business/tenancy
// schema owned by the db-supabase agent). Per src/db/README.md's judgment
// call #1: Better Auth owns these tables via its own migration pipeline
// (src/modules/identity/migrations/, applied by src/modules/identity/migrate.ts),
// so the business migration journal under src/db/migrations/ never fights
// over the same objects.
//
// Field names (camelCase JS property keys) MUST match better-auth's internal
// `getAuthTables()` field keys exactly -- the drizzle adapter looks up
// `schema[model][fieldKey]` by that property name, independent of the actual
// Postgres column name (snake_case here, which is just cosmetic). Verified
// against the installed better-auth@1.2.x `getAuthTables()` source.
//
// Deliberately NO row level security here: these are global, non-tenant
// tables. The only code path that touches them is Better Auth's own request
// handler (src/modules/identity/auth.ts via the /api/auth/[...all] route),
// which already scopes every read/write to the authenticated session's own
// token/user. Do NOT add an ad-hoc query against this schema from app code
// -- go through getSession()/Better Auth's API, never a raw `db.select()`
// against `user`/`session` from arbitrary request input.
//
// Deliberately NO SQL foreign key from business tables (e.g.
// `memberships.user_id`) to `user.id`: see src/db/README.md judgment call #1
// and docs/platform.md -- kept FK-less on purpose to avoid coupling the two
// independent migration pipelines' apply order. Referential integrity for
// `memberships.user_id` is enforced at the app layer (resolveActor() only
// trusts a membership row that is independently re-verified against a real,
// active row -- see modules/tenancy/resolve-actor.ts).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Added by migration 0002 (team/user-creation phase) -- registered as a
  // Better Auth `user.additionalFields` entry in auth.ts so it round-trips
  // through getSession()'s session.user, NOT via the admin plugin (this
  // project deliberately does not install Better Auth's admin plugin --
  // see modules/tenancy/create-member.ts header comment). Set true by
  // create-member.ts when an owner/manager creates a teammate with an
  // admin-chosen password; cleared by the forced change-password flow
  // (src/app/compte/mot-de-passe) once the user picks their own password.
  // Default false so the normal self-service sign-up path (createStructure
  // flow) is never affected.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
}, (t) => [
  uniqueIndex("user_email_idx").on(t.email),
]);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
}, (t) => [
  uniqueIndex("session_token_idx").on(t.token),
  index("session_user_id_idx").on(t.userId),
]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  // Argon2/bcrypt hash for the email+password provider -- never a raw
  // password. Better Auth hashes it internally before this column is
  // written; nothing in app code ever sees or logs the plaintext.
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("account_user_id_idx").on(t.userId),
]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// M5 (security-reviewer finding) -- Better Auth's own DB-backed rate-limit
// bucket table (`rateLimit: { storage: "database" }` in auth.ts). Required
// because Better Auth's default in-memory limiter is per-process state, which
// does NOT work across separate serverless invocations on Vercel (each
// invocation can be a cold, isolated process) -- a DB-backed bucket is the
// only limiter that actually limits anything in that deployment target.
// Field names/shape must match better-auth@1.2.x's internal rate-limit table
// definition exactly (key/count/lastRequest + the implicit "id" every
// Better Auth model gets) -- verified against the installed version's
// `getAuthTables()` source.
// ---------------------------------------------------------------------------
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("rate_limit_key_idx").on(t.key),
]);
