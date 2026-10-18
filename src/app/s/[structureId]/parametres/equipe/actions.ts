"use server";

import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { assignMemberWarehouse } from "@/modules/tenancy/assign-member-warehouse";
import { UnauthenticatedError } from "@/platform/errors";

// ---------------------------------------------------------------------------
// assignMemberWarehouseAction -- multi-store (migration 0014): "assigning a
// store to an existing member" on /parametres/equipe. Real, owner-gated,
// fully wired end to end (getSession -> resolveActor -> withTenantSession ->
// assignMemberWarehouse, which does its own owner check + audit append).
//
// NOT yet called by the UI: `/parametres/equipe` itself still renders
// sample data (see mock-team.ts) -- no real membership roster is queried
// there yet (a pre-existing gap, unrelated to multi-store, documented in
// docs/platform.md's "Known gaps" list). This action is ready for the day
// that screen is wired to the real `memberships` table; until then the
// store-assignment control in team-list-client.tsx stays disabled
// ("Bientôt disponible"), same convention already used there for invite.
// ---------------------------------------------------------------------------
export async function assignMemberWarehouseAction(
  structureId: string,
  memberUserId: string,
  warehouseId: string | null
): Promise<void> {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  await withTenantSession(actor, (ctx) => assignMemberWarehouse(ctx, { memberUserId, warehouseId }));
}
