import { sql } from "drizzle-orm";
import { db } from "@/db/index";
import { UnauthenticatedError } from "@/platform/errors";
import type { AuthSession } from "./resolve-actor";
import type { MembershipRole } from "./types";

export interface MyMembership {
  structureId: string;
  role: MembershipRole;
  structureName: string;
}

// ---------------------------------------------------------------------------
// Post-login "which structure(s) am I in" lookup -- calls the
// `my_memberships()` SECURITY DEFINER SQL function (migration
// 0002_my_memberships.sql), which is filtered strictly by the authenticated
// user's own id (app.user_id), never by anything client-supplied. This is
// the one read that is allowed to happen BEFORE a structureId is known --
// everything else in the app requires resolveActor() first.
// ---------------------------------------------------------------------------

export async function listMyMemberships(
  session: AuthSession | null
): Promise<MyMembership[]> {
  if (!session?.user?.id) {
    throw new UnauthenticatedError();
  }
  const userId = session.user.id;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', '', true)`);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);

    const rows = await tx.execute<{
      structure_id: string;
      role: MembershipRole;
      structure_name: string;
    }>(sql`select * from my_memberships()`);

    return Array.from(rows).map((r) => ({
      structureId: r.structure_id,
      role: r.role,
      structureName: r.structure_name,
    }));
  });
}
