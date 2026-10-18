import { sql } from "drizzle-orm";
import { db } from "@/db/index";
import { UnauthenticatedError } from "@/platform/errors";
import { createAuditWriter } from "@/platform/audit/audit-writer";
import type { AuthSession } from "./resolve-actor";

// ---------------------------------------------------------------------------
// createStructure -- the "créer ma boutique" flow for a logged-in user
// with NO structure yet (a genuine dead end today, per the coordinator's
// instruction). Wraps `create_structure_with_owner()` (SECURITY DEFINER,
// migration 0003), which atomically creates the structure row and the
// caller's first `owner` membership row -- a structure can never exist
// with zero members. Same pattern as `my_memberships()`
// (`src/modules/tenancy/my-memberships.ts`): there is no Actor/structureId
// yet, so this runs its own short transaction directly against the raw
// `db` client (allow-listed in .eslintrc.json for exactly this reason),
// never through `withTenantSession` (which requires an already-verified
// Actor this function is in the business of CREATING).
//
// v1 decisions (no UI asks for these): a single default warehouse and a
// single default unit are created implicitly -- no warehouse/unit
// selector anywhere in this phase (architect's decision).
// ---------------------------------------------------------------------------

export type SupportedCountryCode = "SN" | "GN";

const CURRENCY_BY_COUNTRY: Record<SupportedCountryCode, string> = {
  SN: "XOF",
  GN: "GNF",
};

export class InvalidStructureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStructureInputError";
  }
}

export interface CreateStructureInput {
  name: string;
  countryCode: SupportedCountryCode;
  // numeric(5,2) string, e.g. "0" or "18.00" -- default "0" (most small
  // shops aren't VAT-registered, D4).
  vatRate: string;
}

const VAT_RATE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

export async function createStructure(
  session: AuthSession | null,
  input: CreateStructureInput
): Promise<{ structureId: string }> {
  if (!session?.user?.id) {
    throw new UnauthenticatedError();
  }
  const userId = session.user.id;

  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new InvalidStructureInputError("Le nom de la boutique est requis (200 caractères maximum).");
  }
  const currencyCode = CURRENCY_BY_COUNTRY[input.countryCode];
  if (!currencyCode) {
    throw new InvalidStructureInputError("Pays non reconnu.");
  }
  const vatRate = input.vatRate.trim() || "0";
  if (!VAT_RATE_PATTERN.test(vatRate)) {
    throw new InvalidStructureInputError("Taux de TVA invalide.");
  }

  return db.transaction(async (tx) => {
    // Defense in depth reset, same discipline as withTenantSession.
    await tx.execute(sql`select set_config('app.user_id', '', true)`);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);

    const rows = await tx.execute<{ id: string }>(sql`
      select create_structure_with_owner(${name}, ${input.countryCode}, ${currencyCode}, ${userId}, 'cump') as id
    `);
    const structureId = rows[0]?.id;
    if (!structureId) {
      throw new Error("create_structure_with_owner() returned no structure id.");
    }

    // From here on, the caller IS a verified owner of this brand-new
    // structure (the function just created that membership atomically) --
    // safe to set app.structure_id for the rest of this same transaction.
    await tx.execute(sql`select set_config('app.structure_id', '', true)`);
    await tx.execute(sql`select set_config('app.structure_id', ${structureId}, true)`);

    await tx.execute(sql`
      insert into warehouses (structure_id, name, is_default)
      values (${structureId}, 'Entrepôt principal', true)
    `);
    await tx.execute(sql`
      insert into units (structure_id, code, name)
      values (${structureId}, 'unite', 'Unité')
    `);
    await tx.execute(sql`
      insert into tax_settings (structure_id, vat_rate)
      values (${structureId}, ${vatRate})
    `);

    // M6 fix (security-reviewer, Medium): a new tenant's audit chain
    // (per-tenant, hash-chained, D10) previously started with NO entry at
    // all for its own founding privilege grant (owner membership created
    // atomically by create_structure_with_owner). Appended in the SAME
    // transaction as everything else here -- ids + amounts only, no PII.
    const audit = createAuditWriter(tx, { userId, structureId, role: "owner" });
    await audit.append({
      action: "structure.created",
      targetType: "structure",
      targetId: structureId,
      payload: { countryCode: input.countryCode, currencyCode, vatRate },
    });

    return { structureId };
  });
}
