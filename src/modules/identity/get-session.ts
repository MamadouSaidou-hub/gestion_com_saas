import { headers } from "next/headers";
import { auth } from "./auth";

// Thin server-side helper: resolves the current Better Auth session from the
// incoming request's cookies, for use in Server Components / Server
// Actions / Route Handlers. Returns null when there is no valid session --
// callers (e.g. resolveActor) are responsible for turning that into an
// UnauthenticatedError / redirect, this helper never throws.
export async function getSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}
