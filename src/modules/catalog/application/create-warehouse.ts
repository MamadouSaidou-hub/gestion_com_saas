import { z } from "zod";
import { assertCan } from "@/modules/tenancy/permissions";
import { ForbiddenError } from "@/platform/errors";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { DuplicateWarehouseCodeError } from "../domain/errors";
import type { WarehouseRepository } from "./ports";
import type { WarehouseDto } from "./dto";
import { toWarehouseDto } from "./mappers";

export interface CreateWarehouseRequest {
  code: string;
  name: string;
  kind: "store" | "depot";
  address?: string | null;
  phone?: string | null;
}

const createWarehouseSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["store", "depot"]),
  address: z.string().trim().max(500).nullable().optional(),
  // E.164-ish, same loose validation convention as suppliers/customers --
  // D7: clear text, tenant-scoped, no HMAC.
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,15}$/)
    .nullable()
    .optional(),
});

// ---------------------------------------------------------------------------
// createWarehouse -- owner-gated (`warehouse:write` is also held by
// manager/stock_keeper in the matrix for editing PRODUCT-side warehouse
// metadata via other screens, but the product decision for THIS screen --
// "Magasins", creating/archiving a selling location or depot -- is
// explicitly owner-only per the coordinator's brief). Enforced here, not
// just by hiding the button in the UI (non-negotiable, security.md §1).
// ---------------------------------------------------------------------------
export async function createWarehouse(
  ctx: TenantSessionContext,
  rawInput: CreateWarehouseRequest,
  repo: WarehouseRepository
): Promise<WarehouseDto> {
  // `warehouse:write` in the shared permission matrix is also held by
  // manager/stock_keeper for other, non-owner-only product-side screens --
  // creating/archiving a STORE itself (this screen, "Magasins") is a
  // separate, owner-only product decision, enforced here with a direct
  // role check rather than growing the matrix with a second, never-reused
  // permission. Still `assertCan`-equivalent: fail-closed, server-side,
  // throws the same `ForbiddenError` shape.
  assertCan(ctx.actor, "warehouse:write");
  if (ctx.actor.role !== "owner") {
    throw new ForbiddenError('Only an "owner" may create a store or depot.');
  }

  const input = createWarehouseSchema.parse(rawInput);

  const existing = await repo.findByCode(ctx, input.code);
  if (existing) {
    throw new DuplicateWarehouseCodeError(input.code);
  }

  const warehouse = await repo.insert(ctx, {
    code: input.code,
    name: input.name,
    kind: input.kind,
    address: input.address ?? null,
    phone: input.phone ?? null,
  });

  await ctx.audit.append({
    action: "warehouse.created",
    targetType: "warehouse",
    targetId: warehouse.id,
    payload: { code: warehouse.code, kind: warehouse.kind },
  });

  return toWarehouseDto(warehouse);
}
