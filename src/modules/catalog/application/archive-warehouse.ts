import { assertCan } from "@/modules/tenancy/permissions";
import { ForbiddenError } from "@/platform/errors";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { WarehouseNotFoundError, InvalidWarehouseInputError } from "../domain/errors";
import type { WarehouseRepository } from "./ports";
import type { WarehouseDto } from "./dto";
import { toWarehouseDto } from "./mappers";

// Owner-gated, same rationale as createWarehouse. Never a hard delete --
// stock_movements/sales/payments/stock_transfers all composite-FK onto
// `warehouses`, years of history can reference it; archiving only flips
// `is_active` so it stops showing up in the POS/stock store selector.
export async function archiveWarehouse(
  ctx: TenantSessionContext,
  warehouseId: string,
  repo: WarehouseRepository
): Promise<WarehouseDto> {
  assertCan(ctx.actor, "warehouse:write");
  if (ctx.actor.role !== "owner") {
    throw new ForbiddenError('Only an "owner" may archive a store or depot.');
  }

  const existing = await repo.findById(ctx, warehouseId);
  if (!existing) {
    throw new WarehouseNotFoundError(warehouseId);
  }
  // Known limitation, documented rather than engineered around in this
  // pass: a gerant's membership can be pinned to this exact warehouse
  // (`memberships.warehouse_id`, migration 0014). Archiving it does NOT
  // reassign or null out that membership -- catalog cannot reach into
  // tenancy's own schema to check (cross-module boundary rule), and no
  // DB-level guard exists for this either. An archived store's gerant is
  // left scoped to a now-inactive store (fail-closed in effect: every
  // store-scoped query for them keeps returning only that store's rows,
  // never silently widening to "all stores") until an owner reassigns
  // them via /parametres/equipe. Flag for security-reviewer.
  if (existing.isDefault) {
    throw new InvalidWarehouseInputError("Cannot archive the structure's default warehouse.");
  }

  const warehouse = await repo.setActive(ctx, warehouseId, false);

  await ctx.audit.append({
    action: "warehouse.archived",
    targetType: "warehouse",
    targetId: warehouse.id,
    payload: { code: warehouse.code },
  });

  return toWarehouseDto(warehouse);
}
