import { z } from "zod";
import { assertCan } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { InvalidSupplierInputError } from "../domain/errors";
import type { SupplierRepository } from "./ports";
import type { SupplierDto } from "./dto";
import { toSupplierDto } from "./mappers";

export interface CreateSupplierRequest {
  name: string;
  phone?: string | null;
  email?: string | null;
}

// D7: phone stored clear-text, E.164, tenant-scoped -- same loose
// validation convention as customers/warehouses.
const createSupplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,15}$/)
    .nullable()
    .optional(),
  email: z.string().trim().email().nullable().optional(),
});

export async function createSupplier(
  ctx: TenantSessionContext,
  rawInput: CreateSupplierRequest,
  repo: SupplierRepository
): Promise<SupplierDto> {
  assertCan(ctx.actor, "supplier:write");
  const input = createSupplierSchema.parse(rawInput);

  const existing = await repo.findByName(ctx, input.name.trim());
  if (existing) {
    throw new InvalidSupplierInputError(`Un fournisseur nommé "${input.name}" existe déjà.`);
  }

  const supplier = await repo.insert(ctx, {
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
  });

  // ids only -- no name/phone/email in the audit payload (PII guard).
  await ctx.audit.append({
    action: "supplier.created",
    targetType: "supplier",
    targetId: supplier.id,
    payload: {},
  });

  return toSupplierDto(supplier);
}
