"use client";

import { createAuthClient } from "better-auth/react";

// H4 (security-reviewer finding): NEXT_PUBLIC_APP_URL used to silently fall
// back to http://localhost:3000. NEXT_PUBLIC_* vars are inlined at build
// time, so failing loudly here fails the BUILD (or at worst, the first
// module evaluation) instead of quietly shipping a client that talks to
// localhost from a deployed origin.
//
// IMPORTANT: Next.js only inlines NEXT_PUBLIC_* vars into the client bundle
// for a STATIC `process.env.NEXT_PUBLIC_X` member expression -- a dynamic
// `process.env[name]` lookup is never replaced, so in the browser
// `process.env` doesn't actually contain it and this always evaluates to
// undefined regardless of what's in .env. The value must be read with a
// literal, static expression and passed in.
function requiredPublicEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} must be set (see .env.example).`);
  }
  return value;
}

// Client-side Better Auth instance for the login form (and any future
// client components that need signIn/signOut/useSession). Talks to the
// /api/auth/[...all] Route Handler -- never touches the database directly.
export const authClient = createAuthClient({
  baseURL: requiredPublicEnv(process.env.NEXT_PUBLIC_APP_URL, "NEXT_PUBLIC_APP_URL"),
});
