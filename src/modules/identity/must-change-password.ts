import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { user } from "./schema";
import type { AuthSession } from "@/modules/tenancy/resolve-actor";

// ---------------------------------------------------------------------------
// Force-password-change gate (team/user-creation phase). A teammate created
// via create-member.ts gets `mustChangePassword = true`; this is the single
// place every protected entry point (the structure picker and the
// structure layout) redirects away from the app until it's cleared.
//
// `session.user.mustChangePassword` round-trips through Better Auth
// because it's registered as a `user.additionalFields` entry (auth.ts) --
// no extra DB query needed here, we read it straight off the already-
// resolved session.
// ---------------------------------------------------------------------------

type SessionWithMustChangePassword = AuthSession & {
  user: { mustChangePassword?: boolean | null };
};

export function redirectIfMustChangePassword(
  session: SessionWithMustChangePassword,
  nextPath: string
): void {
  if (session.user.mustChangePassword) {
    redirect(`/compte/mot-de-passe?next=${encodeURIComponent(nextPath)}`);
  }
}

// Called by the change-password page's Server Action after
// authClient.changePassword() succeeds. Identity tables have no RLS/tenant
// dimension (see schema.ts) -- a direct update against the raw `db` client
// is the documented, allow-listed pattern for this module (same as
// create-structure.ts/my-memberships.ts), not a withTenantSession bypass:
// there is no tenant context for "my own user row" to begin with.
export async function clearMustChangePassword(userId: string): Promise<void> {
  await db.update(user).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(user.id, userId));
}
