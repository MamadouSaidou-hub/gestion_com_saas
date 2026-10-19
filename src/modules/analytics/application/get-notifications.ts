import { assertCan, can, resolveStoreScope, storeScopeFor } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { inventoryService } from "@/modules/inventory";
import { billingService } from "@/modules/billing";
import { stockTransfersService } from "@/modules/stock-transfers";
import { rebatesService } from "@/modules/rebates";
import { moneyFromDto } from "@/platform/dto/money";

export type NotificationKind =
  | "low_stock"
  | "receivable_overdue"
  | "receivable_due_soon"
  | "transfer_awaiting_receipt"
  | "rebate_tier_reached";

export interface NotificationItem {
  kind: NotificationKind;
  // Opaque id for React keys / dedup -- never a cross-entity primary key
  // reused across kinds.
  id: string;
  // Ids the UI can build a link from -- never PII (names, phone, etc).
  productId?: string;
  warehouseId?: string;
  customerId?: string;
  supplierId?: string;
  transferId?: string;
}

const REBATE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// getNotifications -- DERIVED, never persisted (no table, no worker, no
// cron -- see docs/platform.md's note on this decision). Reuses the EXACT
// same sources the dashboard already computes (low stock, receivables,
// transfers, rebate grants) rather than duplicating their definitions.
// Role- AND store-aware: each section is gated on the permission that
// makes the alert ACTIONABLE for that role (not just readable) -- e.g. a
// cashier holds `customer:read` but the receivable section ALSO requires
// `payment:record` (which a cashier does hold, so they DO see it; an
// actor who can read but never collect a payment would not).
// `dashboard:read` alone is the floor -- every member of the structure.
// ---------------------------------------------------------------------------
export async function getNotifications(ctx: TenantSessionContext): Promise<NotificationItem[]> {
  assertCan(ctx.actor, "dashboard:read");

  const storeScope = resolveStoreScope(ctx.actor, null);
  const items: NotificationItem[] = [];

  const tasks: Array<Promise<void>> = [];

  if (can(ctx.actor, "stock:read")) {
    tasks.push(
      inventoryService.listLowStock(ctx, storeScope).then((alerts) => {
        for (const a of alerts) {
          items.push({
            kind: "low_stock",
            id: `low_stock:${a.productId}:${a.warehouseId}`,
            productId: a.productId,
            warehouseId: a.warehouseId,
          });
        }
      })
    );
  }

  if (can(ctx.actor, "customer:read") && can(ctx.actor, "payment:record")) {
    tasks.push(
      billingService.getReceivablesByCustomer(ctx, storeScope).then((rows) => {
        for (const r of rows) {
          if (moneyFromDto(r.overdueMinor) > 0n) {
            items.push({ kind: "receivable_overdue", id: `receivable_overdue:${r.customerId}`, customerId: r.customerId });
          } else if (moneyFromDto(r.dueSoonMinor) > 0n) {
            items.push({ kind: "receivable_due_soon", id: `receivable_due_soon:${r.customerId}`, customerId: r.customerId });
          }
        }
      })
    );
  }

  if (can(ctx.actor, "transfer:receive")) {
    const ownStore = storeScopeFor(ctx.actor);
    tasks.push(
      stockTransfersService
        .listTransfers(ctx, { storeScope, status: "in_transit", limit: 50 })
        .then((transfers) => {
          for (const t of transfers) {
            // Actionable ONLY from the destination side -- an owner
            // (unscoped) sees every in-transit transfer tenant-wide;
            // a store-scoped actor sees only the ones headed TO their
            // own store (the leg they can actually receive).
            if (ownStore !== null && t.toWarehouseId !== ownStore) {
              continue;
            }
            items.push({ kind: "transfer_awaiting_receipt", id: `transfer:${t.id}`, transferId: t.id });
          }
        })
    );
  }

  if (can(ctx.actor, "rebate:read")) {
    tasks.push(
      rebatesService.listRecentGrants(ctx, new Date(Date.now() - REBATE_LOOKBACK_MS)).then((grants) => {
        for (const g of grants) {
          items.push({
            kind: "rebate_tier_reached",
            id: `rebate_grant:${g.id}`,
            customerId: g.customerId ?? undefined,
            supplierId: g.supplierId ?? undefined,
          });
        }
      })
    );
  }

  await Promise.all(tasks);
  return items;
}
