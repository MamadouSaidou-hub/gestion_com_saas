import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/modules/identity/auth";

// Single catch-all Route Handler for every Better Auth endpoint
// (/api/auth/sign-in/email, /api/auth/sign-out, /api/auth/session, ...).
// This file is the ONLY place Better Auth is exposed over HTTP -- app code
// never queries the `user`/`session` tables directly (see
// modules/identity/schema.ts).
export const { GET, POST } = toNextJsHandler(auth);
