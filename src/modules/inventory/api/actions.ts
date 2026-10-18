"use server";

import { z } from "zod";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { UnauthenticatedError } from "@/platform/errors";
import { inventoryService } from "../index";

// ---------------------------------------------------------------------------
// Thin Server Actions for the inventory module -- NOT wired to any screen
// yet (`/stocks` stays on mock data this phase). Same five-step chain as
// catalog's actions.ts: getSession -> resolveActor -> withTenantSession ->
// use case (assertCan happens inside the use case, not here).
// ---------------------------------------------------------------------------

const quantityStringSchema = z.string().regex(/^-?\d+(\.\d{1,4})?$/);
const moneyStringSchema = z.string().regex(/^-?\d+$/);

const receiveStockSchema = z.object({
  productId: z.uuid(),
  warehouseId: z.uuid(),
  quantity: quantityStringSchema,
  unitCostMinor: moneyStringSchema,
  currencyCode: z.string().length(3),
  reason: z.string().optional(),
});

const adjustStockSchema = z.object({
  productId: z.uuid(),
  warehouseId: z.uuid(),
  direction: z.enum(["in", "out"]),
  quantity: quantityStringSchema,
  currencyCode: z.string().length(3),
  reason: z.string().trim().min(1),
});

export async function receiveStockAction(structureId: string, formData: FormData) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  const parsed = receiveStockSchema.parse({
    productId: formData.get("productId"),
    warehouseId: formData.get("warehouseId"),
    quantity: formData.get("quantity"),
    unitCostMinor: formData.get("unitCostMinor"),
    currencyCode: formData.get("currencyCode"),
    reason: formData.get("reason") || undefined,
  });
  return withTenantSession(actor, (ctx) => inventoryService.receiveStock(ctx, parsed));
}

export async function adjustStockAction(structureId: string, formData: FormData) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  const parsed = adjustStockSchema.parse({
    productId: formData.get("productId"),
    warehouseId: formData.get("warehouseId"),
    direction: formData.get("direction"),
    quantity: formData.get("quantity"),
    currencyCode: formData.get("currencyCode"),
    reason: formData.get("reason"),
  });
  return withTenantSession(actor, (ctx) => inventoryService.adjustStock(ctx, parsed));
}

export async function getStockLevelsAction(structureId: string, warehouseId?: string) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  return withTenantSession(actor, (ctx) => inventoryService.getStockLevels(ctx, { warehouseId }));
}

// multi-store: `warehouseId` optional -- omitted/undefined aggregates
// across every store the actor can see (via `resolveStoreScope`, applied
// by `analyticsService`/other callers); this thin action simply forwards
// whatever the caller resolved, it does not resolve scope itself.
export async function listLowStockAction(structureId: string, warehouseId: string | null = null) {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  const actor = await resolveActor(session, structureId);
  return withTenantSession(actor, (ctx) => inventoryService.listLowStock(ctx, warehouseId));
}
