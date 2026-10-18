import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/index";
import { memberships } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import type { Actor } from "./types";

// M8 (security-reviewer finding): `structureId` comes straight off the URL
// (e.g. /s/[structureId]/...) and is client-controlled/untrusted. Before
// this fix, an invalid UUID reached the `eq(memberships.structureId, ...)`
// Postgres `uuid` column comparison unchecked and blew up with an unhandled
// cast error (500) -- a behaviour distinguishable from "valid UUID, just not
// a member", which is exactly the kind of oracle an attacker can use to
// probe which path segments look like real ids. Validate shape FIRST and
// fold a bad shape into the SAME NotAMemberError a real non-member gets, so
// the two cases are indistinguishable to the caller.
const structureIdSchema = z.uuid();

// Minimal shape this module needs from Better Auth's session -- kept narrow
// so this file doesn't import the whole identity module (avoids a circular
// module dependency between tenancy and identity).
export interface AuthSession {
  user: { id: string };
}

// ---------------------------------------------------------------------------
// resolveActor -- the ONLY place a `structureId` coming from the URL is
// turned into tenant context, and it NEVER trusts that value by itself.
//
// `structureIdFromUrl` is purely a UX convenience (stable, bookmarkable,
// shareable URLs per CLAUDE.md / performance.md) -- it is never used for
// authorization on its own. Authorization comes entirely from the DB round
// trip below: we set the session GUCs from (a) the authenticated user id,
// which the caller got from a verified Better Auth session, never from a
// header/cookie value we parse ourselves, and (b) the candidate structureId,
// then ask Postgres -- under RLS -- whether an ACTIVE membership row for
// that exact (user, structure) pair exists. If the candidate structureId is
// a structure the caller is not on, the RLS-scoped SELECT below returns zero
// rows and we throw, independent of anything the client claimed.
//
// This runs in its own short, read-only transaction (via drizzle's own
// `db.transaction()`, same mechanism as withTenantSession -- see that file
// for why a raw postgres.js `client.begin()` + a fresh `drizzle(tx, ...)`
// call is NOT used here) rather than inside withTenantSession() because the
// actor (and therefore the GUCs withTenantSession would set) doesn't exist
// yet -- that's exactly what this function is computing. Once it returns a
// verified Actor, every subsequent DB access for this request must go
// through withTenantSession(actor, fn).
// ---------------------------------------------------------------------------

export async function resolveActor(
  session: AuthSession | null,
  structureIdFromUrl: string
): Promise<Actor> {
  if (!session?.user?.id) {
    throw new UnauthenticatedError();
  }
  const userId = session.user.id;

  // M8: fail closed on malformed input the exact same way as "not a member"
  // -- never a distinguishable 500/cast error.
  const parsedStructureId = structureIdSchema.safeParse(structureIdFromUrl);
  if (!parsedStructureId.success) {
    throw new NotAMemberError();
  }

  const row = await db.transaction(async (tx) => {
    // Defense in depth, same rationale as withTenantSession.ts.
    await tx.execute(sql`select set_config('app.structure_id', '', true)`);
    await tx.execute(sql`select set_config('app.user_id', '', true)`);

    // userId comes from the verified session (server-side), never from the
    // client directly. structureIdFromUrl is client-supplied and UNTRUSTED
    // until the query below confirms it against a real membership row.
    await tx.execute(
      sql`select set_config('app.structure_id', ${structureIdFromUrl}, true)`
    );
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);

    const rows = await tx
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.structureId, structureIdFromUrl),
          eq(memberships.status, "active")
        )
      )
      .limit(1);

    return rows[0] ?? null;
  });

  if (!row) {
    throw new NotAMemberError();
  }

  return {
    userId,
    structureId: structureIdFromUrl,
    role: row.role,
  };
}
