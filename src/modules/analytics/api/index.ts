"use server";

import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { UnauthenticatedError, NotAMemberError } from "@/platform/errors";
import { analyticsService, type SearchResultDto } from "../index";

// ---------------------------------------------------------------------------
// analytics/api -- RSC dashboard page data-fetching happens directly via
// `analyticsService` + `withTenantSession` inside each page (read-only,
// no Server Action needed there). `searchAction` below is the ONE
// exception: the app shell's topbar search box is a Client Component, so
// it needs a real Server Action entry point, ONE round trip per keystroke
// (debounced client-side), never a separate action per section.
// ---------------------------------------------------------------------------

const EMPTY_RESULT: SearchResultDto = { products: [], customers: [], suppliers: [], sales: [], transfers: [] };

export async function searchAction(structureId: string, query: string): Promise<SearchResultDto> {
  try {
    const session = await getSession();
    if (!session) {
      return EMPTY_RESULT;
    }
    const actor = await resolveActor(session, structureId);
    return await withTenantSession(actor, (ctx) => analyticsService.globalSearch(ctx, query));
  } catch (err) {
    if (err instanceof UnauthenticatedError || err instanceof NotAMemberError) {
      return EMPTY_RESULT;
    }
    throw err;
  }
}
