import { z } from "zod";
import { assertCan } from "@/modules/tenancy/permissions";
import { moneyFromDto } from "@/platform/dto/money";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { CustomerNotFoundError } from "../domain/errors";
import type { CustomerRepository } from "./ports";
import type { CustomerDto } from "./dto";
import { toCustomerDto } from "./mappers";

export interface UpdateCustomerRequest {
  name?: string;
  phone?: string | null;
  email?: string | null;
  isActive?: boolean;
  creditLimitMinor?: string | null;
  defaultPaymentTermsDays?: number | null;
  address?: string | null;
  notes?: string | null;
}

const updateCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,15}$/)
    .nullable()
    .optional(),
  email: z.string().trim().email().nullable().optional(),
  isActive: z.boolean().optional(),
  creditLimitMinor: z.string().regex(/^\d+$/).nullable().optional(),
  defaultPaymentTermsDays: z.number().int().min(0).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function updateCustomer(
  ctx: TenantSessionContext,
  customerId: string,
  rawInput: UpdateCustomerRequest,
  repo: CustomerRepository
): Promise<CustomerDto> {
  assertCan(ctx.actor, "customer:write");
  const input = updateCustomerSchema.parse(rawInput);

  const existing = await repo.findById(ctx, customerId);
  if (!existing) {
    throw new CustomerNotFoundError(customerId);
  }

  const customer = await repo.update(ctx, customerId, {
    name: input.name,
    phone: input.phone,
    email: input.email,
    isActive: input.isActive,
    creditLimitMinor:
      input.creditLimitMinor !== undefined
        ? input.creditLimitMinor === null
          ? null
          : moneyFromDto(input.creditLimitMinor)
        : undefined,
    defaultPaymentTermsDays: input.defaultPaymentTermsDays,
    address: input.address,
    notes: input.notes,
  });

  // ids only -- see create-customer.ts's comment on the PII guard.
  await ctx.audit.append({
    action: "customer.updated",
    targetType: "customer",
    targetId: customer.id,
    payload: {},
  });

  return toCustomerDto(customer);
}
