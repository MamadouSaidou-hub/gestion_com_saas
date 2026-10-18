"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { assertCan } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { UnauthenticatedError } from "@/platform/errors";

const renameInput = z.object({
  name: z.string().trim().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Demonstrative Server Action: "update structure display name". This is the
// one place that exercises the FULL chain end to end, in order:
//
//   getSession()        -- who is making the request (server-verified, not
//                           a client-supplied header/cookie we parse by hand)
//   resolveActor()       -- is this real user an ACTIVE member of THIS
//                           structure, re-checked against `memberships`
//                           (never trusts `structureId` from the URL alone)
//   assertCan()           -- does this role have "settings:write" (fail-
//                           closed permission matrix, server-side only)
//   withTenantSession()   -- every DB read/write below runs inside ONE
//                           transaction with app.structure_id/app.user_id
//                           set from the verified actor, under RLS
//   AuditWriter.append()  -- "settings.changed" is appended to the
//                           per-tenant hash chain in the SAME transaction as
//                           the write, so one can't commit without the other
//
// `structureId` is bound by the calling page via `.bind(null, structureId)`
// on the <form action={...}> -- it is still re-verified by resolveActor()
// here, exactly as if it had come straight from an attacker-controlled URL,
// because a bound server action argument is not inherently more trustworthy
// than a form field; the server is the only thing that gets to decide.
// ---------------------------------------------------------------------------

export async function updateStructureDisplayName(
  structureId: string,
  formData: FormData
): Promise<void> {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }

  const actor = await resolveActor(session, structureId);
  assertCan(actor, "settings:write");

  const parsed = renameInput.parse({ name: formData.get("name") });

  await withTenantSession(actor, async ({ db, audit }) => {
    const [before] = await db
      .select({ name: structures.name })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);

    await db
      .update(structures)
      .set({ name: parsed.name })
      .where(eq(structures.id, actor.structureId));

    await audit.append({
      action: "settings.changed",
      targetType: "structure",
      targetId: actor.structureId,
      payload: { field: "name", before: before?.name ?? null, after: parsed.name },
    });
  });

  revalidatePath(`/s/${structureId}/dashboard`);
}
