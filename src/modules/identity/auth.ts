import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db/index";
import * as identitySchema from "./schema";

// ---------------------------------------------------------------------------
// Better Auth server instance. Uses the SAME app_user connection as the rest
// of the app (src/db/index.ts) -- identity tables are global/non-tenant
// (never gated by app.structure_id/app.user_id), so there is no need to run
// Better Auth's own queries through withTenantSession(). See
// modules/identity/schema.ts for why these tables live in their own
// migration journal.
//
// emailVerification is intentionally left disabled for this scaffold (no
// transactional email provider wired yet) -- a real deployment should turn
// it on once an email/OTP sender (D5 in CLAUDE.md) exists; flagged for
// security-reviewer.
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set (see .env.example).`);
  }
  return value;
}

// H4 (security-reviewer finding): BETTER_AUTH_URL used to fall back silently
// to http://localhost:3000, which means a misconfigured deployment would
// come up with insecure (non-HTTPS-pinned) cookie/origin behaviour instead of
// failing to boot. Fail loudly instead.
const betterAuthUrl = requiredEnv("BETTER_AUTH_URL");

const isProduction = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: identitySchema,
    usePlural: false,
  }),
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  baseURL: betterAuthUrl,
  // Team/user-creation phase: registers the `must_change_password` column
  // (schema.ts, identity migration 0002) with Better Auth itself so it
  // round-trips through getSession()'s session.user -- without this,
  // Better Auth's own field list (derived from getAuthTables(), not from
  // our drizzle table object directly) would silently drop the column from
  // every select/insert it issues, even though the column exists in
  // Postgres. `input: false` -- never settable by a normal client call
  // (e.g. a future self-service "update profile" endpoint); only
  // create-member.ts (a direct SQL write under withTenantSession, see that
  // file's header) and the forced change-password flow are allowed to
  // change it.
  user: {
    additionalFields: {
      mustChangePassword: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },
  // H4: don't rely on Better Auth's own origin-sniffing defaults -- pin the
  // exact set of origins allowed to drive auth flows (CSRF/open-redirect
  // surface). Same value as baseURL today (single first-party frontend);
  // extend explicitly if a second trusted origin (e.g. a marketing site that
  // embeds sign-in) is ever added.
  trustedOrigins: [betterAuthUrl],
  emailAndPassword: {
    enabled: true,
    // Better Auth hashes with scrypt internally -- no plaintext password
    // ever reaches application code or logs.
    autoSignIn: true,
  },
  session: {
    // M5 (security-reviewer finding): the previous `maxAge: 60` cookie cache
    // meant a revoked/expired session could still be accepted for up to 60s
    // without hitting the DB -- unacceptable for D6's break-glass/time-boxed
    // support access requirement, where revocation needs to take effect
    // immediately, not "within a minute".
    //
    // Tradeoff we're documenting rather than hiding: disabling the cache
    // entirely means every authenticated request pays one extra DB
    // round-trip to validate the session. We accept that cost for
    // correctness on this project (D6 is explicit about immediate
    // revocation) rather than trading it for a short, blind window. If this
    // ever becomes a real latency problem, the right fix is a much shorter
    // cache (a few seconds) PLUS an explicit cache-bust on revoke/break-glass
    // toggle, not silently re-widening this back to 60s.
    cookieCache: { enabled: false },
  },
  // M5: Better Auth's default rate limiter keeps its counters in-process
  // memory, which does not work across separate serverless invocations on
  // Vercel (each invocation can be a distinct, short-lived process with no
  // shared memory) -- the limiter would silently limit nothing in that
  // deployment target. Back it by Postgres (the `rate_limit` table added in
  // modules/identity/migrations/0000_identity_core.sql) so limits are
  // actually enforced across invocations/instances.
  rateLimit: {
    enabled: true,
    storage: "database",
    // Defaults (window/max) are Better Auth's own (10s / 100 req) for
    // general endpoints; sign-in/sign-up get Better Auth's built-in stricter
    // special-cased limits automatically. Revisit with real traffic data
    // before launch.
  },
  advanced: {
    // H4: explicit, not inferred from NODE_ENV by Better Auth itself --
    // force Secure cookies outside local dev so a misconfigured
    // staging/prod deployment can never silently serve auth cookies over
    // plain HTTP.
    useSecureCookies: isProduction,
  },
});

export type AppAuth = typeof auth;
