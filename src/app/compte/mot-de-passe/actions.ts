"use server";

import { getSession } from "@/modules/identity/get-session";
import { clearMustChangePassword } from "@/modules/identity/must-change-password";
import { UnauthenticatedError } from "@/platform/errors";

// Called by the client form AFTER authClient.changePassword() succeeds
// (that call already proved the user knows the current/admin-set password
// and set a new one through Better Auth's own, already-hardened endpoint --
// this action never sees either password). Only clears the forced-change
// flag for the CALLER's own session user -- never accepts a userId
// parameter, so there is no way to clear someone else's flag from here.
export async function clearMustChangePasswordAction(): Promise<void> {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  await clearMustChangePassword(session.user.id);
}
