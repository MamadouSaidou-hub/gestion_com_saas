"use server";

import { redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { createStructure, type SupportedCountryCode } from "@/modules/tenancy/create-structure";
import { UnauthenticatedError } from "@/platform/errors";

// Thin Server Action for the "créer ma boutique" flow -- getSession() ->
// createStructure() (which does its own validation + the DB-level
// atomic create_structure_with_owner() call) -> redirect straight into
// the new structure's dashboard. No separate structureId to re-verify
// here (unlike every other action in this app): createStructure() is
// what PRODUCES the structureId, there is nothing upstream to trust or
// distrust yet.
export async function createStructureAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }

  const name = String(formData.get("name") ?? "");
  const countryCode = String(formData.get("countryCode") ?? "SN") as SupportedCountryCode;
  const vatRate = String(formData.get("vatRate") ?? "0");

  const { structureId } = await createStructure(session, { name, countryCode, vatRate });

  redirect(`/s/${structureId}/dashboard`);
}
