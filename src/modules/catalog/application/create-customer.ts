import { z } from "zod";
import { assertCan } from "@/modules/tenancy/permissions";
import { moneyFromDto } from "@/platform/dto/money";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { InvalidCustomerInputError } from "../domain/errors";
import type { CustomerRepository } from "./ports";
import type { CustomerDto } from "./dto";
import { toCustomerDto } from "./mappers";

export interface CreateCustomerRequest {
  name: string;
  phone?: string | null;
  email?: string | null;
  creditLimitMinor?: string | null; // MoneyMinorDto
  defaultPaymentTermsDays?: number | null;
  address?: string | null;
  notes?: string | null;
}

// D7: phone stored clear-text, E.164, tenant-scoped -- loose validation
// (`+` then 6-15 digits), same convention as warehouses/suppliers.
const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,15}$/)
    .nullable()
    .optional(),
  email: z.string().trim().email().nullable().optional(),
  creditLimitMinor: z.string().regex(/^\d+$/).nullable().optional(),
  defaultPaymentTermsDays: z.number().int().min(0).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function createCustomer(
  ctx: TenantSessionContext,
  rawInput: CreateCustomerRequest,
  repo: CustomerRepository
): Promise<CustomerDto> {
  assertCan(ctx.actor, "customer:write");
  const input = createCustomerSchema.parse(rawInput);

  const existing = await repo.findByName(ctx, input.name.trim());
  if (existing) {
    throw new InvalidCustomerInputError(`Un client nommé "${input.name}" existe déjà.`);
  }

  const customer = await repo.insert(ctx, {
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
    creditLimitMinor: input.creditLimitMinor ? moneyFromDto(input.creditLimitMinor) : null,
    defaultPaymentTermsDays: input.defaultPaymentTermsDays ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
  });

  // ids only -- no name/phone/email/address in the audit payload (the PII
  // guard throws on those key names by design, D7).
  await ctx.audit.append({
    action: "customer.created",
    targetType: "customer",
    targetId: customer.id,
    payload: {},
  });

  return toCustomerDto(customer);
}
