import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import { seedStructure, createProduct, setStockLevel, addMembership, addWarehouse, createSupplier } from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";
import type { ConfirmSaleInput } from "@/modules/sales";

// ---------------------------------------------------------------------------
// Trésorerie (treasury) -- proves the figures reconcile with the underlying
// payments/deliveries (not just "returns a number"), and that a
// store-scoped manager's treasury excludes other stores and omits the
// supplier side entirely (never fetched, not fetched-then-hidden -- see
// get-treasury.ts). Same disposable-container convention as every other
// integration suite in this codebase.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let salesService: typeof import("@/modules/sales").salesService;
let billingService: typeof import("@/modules/billing").billingService;
let purchasingService: typeof import("@/modules/purchasing").purchasingService;
let analyticsService: typeof import("@/modules/analytics").analyticsService;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ salesService } = await import("@/modules/sales"));
  ({ billingService } = await import("@/modules/billing"));
  ({ purchasingService } = await import("@/modules/purchasing"));
  ({ analyticsService } = await import("@/modules/analytics"));
});

function actorFor(
  fixture: Awaited<ReturnType<typeof seedStructure>>,
  role: Actor["role"],
  userId: string,
  warehouseId: string | null = null
): Actor {
  return { userId, structureId: fixture.structureId, role, warehouseId };
}

describe("treasury", () => {
  it("reconciles cash sales, receivable collections, and supplier payments/debt with the underlying rows", async () => {
    const fixture = await seedStructure();
    const owner = actorFor(fixture, "owner", fixture.ownerUserId);
    const productId = await createProduct(fixture, { sku: `SKU-${randomUUID()}`, priceMinor: 1000 });
    await setStockLevel(fixture, productId, "1000.0000", 600);

    // 1) Cash sale -- paid in FULL at confirmation time.
    const cashSale = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `idem-${randomUUID()}`,
        warehouseId: fixture.warehouseId,
        currencyCode: "XOF",
        lines: [{ productId, quantity: "2.0000" }], // total = 2000
        payment: { method: "cash", full: true },
      } as ConfirmSaleInput)
    );
    expect(cashSale.totalMinor).toBe("2000");

    // 2) Credit sale -- zero payment at confirmation, paid off LATER
    // (a receivable collection, not a cash sale).
    const creditSale = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `idem-${randomUUID()}`,
        warehouseId: fixture.warehouseId,
        currencyCode: "XOF",
        customerId: fixture.customerId,
        lines: [{ productId, quantity: "3.0000" }], // total = 3000
      } as ConfirmSaleInput)
    );
    await withTenantSession(owner, (ctx) =>
      billingService.recordPayment(ctx, {
        idempotencyKey: `pay-${randomUUID()}`,
        amountMinor: "3000",
        method: "mobile_money",
        saleId: creditSale.saleId,
      })
    );

    // 3) A still-open receivable (sale left unpaid) -- "clients nous doivent".
    const openSale = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `idem-${randomUUID()}`,
        warehouseId: fixture.warehouseId,
        currencyCode: "XOF",
        customerId: fixture.customerId,
        lines: [{ productId, quantity: "1.0000" }], // total = 1000, unpaid
      } as ConfirmSaleInput)
    );
    expect(openSale.totalMinor).toBe("1000");

    // 4) Supplier side -- a delivery, partially paid.
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Test" });
    const delivery = await withTenantSession(owner, (ctx) =>
      purchasingService.recordDelivery(ctx, {
        idempotencyKey: `delivery-${randomUUID()}`,
        supplierId,
        warehouseId: fixture.warehouseId,
        currencyCode: "XOF",
        lines: [{ productId, quantity: "5.0000", unitCostMinor: "500" }], // total = 2500
      })
    );
    expect(delivery.totalMinor).toBe("2500");
    await withTenantSession(owner, (ctx) =>
      purchasingService.recordSupplierPayment(ctx, {
        idempotencyKey: `supplier-pay-${randomUUID()}`,
        supplierId,
        deliveryId: delivery.id,
        amountMinor: "1000",
        method: "cash",
      })
    );

    const treasury = await withTenantSession(owner, (ctx) =>
      analyticsService.getTreasury(ctx, { period: "day" })
    );

    expect(BigInt(treasury.cashSalesMinor)).toBeGreaterThanOrEqual(2000n);
    expect(BigInt(treasury.receivableCollectionsMinor)).toBeGreaterThanOrEqual(3000n);
    expect(BigInt(treasury.totalEncaisseMinor)).toBe(
      BigInt(treasury.cashSalesMinor) + BigInt(treasury.receivableCollectionsMinor)
    );
    expect(BigInt(treasury.receivablesOwedToUsMinor)).toBeGreaterThanOrEqual(1000n);
    expect(treasury.supplier).not.toBeNull();
    expect(BigInt(treasury.supplier!.paymentsMadeMinor)).toBeGreaterThanOrEqual(1000n);
    expect(BigInt(treasury.supplier!.debtOwedMinor)).toBeGreaterThanOrEqual(1500n); // 2500 - 1000
  });

  it("a store-scoped manager's treasury excludes other stores and omits the supplier side entirely", async () => {
    const fixture = await seedStructure();
    const owner = actorFor(fixture, "owner", fixture.ownerUserId);
    const storeB = await addWarehouse(fixture, { code: `B-${randomUUID().slice(0, 6)}`, name: "Store B" });
    const gerantUserId = await addMembership(fixture, "manager", undefined, fixture.warehouseId);
    const gerant = actorFor(fixture, "manager", gerantUserId, fixture.warehouseId);

    const productId = await createProduct(fixture, { sku: `SKU-${randomUUID()}`, priceMinor: 1000 });
    await setStockLevel(fixture, productId, "1000.0000", 600);
    await setStockLevel({ ...fixture, warehouseId: storeB }, productId, "1000.0000", 600);

    // A cash sale in the gerant's OWN store (A, fixture.warehouseId)...
    await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `idem-${randomUUID()}`,
        warehouseId: fixture.warehouseId,
        currencyCode: "XOF",
        lines: [{ productId, quantity: "1.0000" }], // total = 1000
        payment: { method: "cash", full: true },
      } as ConfirmSaleInput)
    );
    // ...and a cash sale in the OTHER store (B), which must NOT leak into
    // the gerant's own treasury figures.
    await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `idem-${randomUUID()}`,
        warehouseId: storeB,
        currencyCode: "XOF",
        lines: [{ productId, quantity: "9.0000" }], // total = 9000
        payment: { method: "cash", full: true },
      } as ConfirmSaleInput)
    );

    const gerantTreasury = await withTenantSession(gerant, (ctx) =>
      analyticsService.getTreasury(ctx, { period: "day" })
    );

    expect(BigInt(gerantTreasury.cashSalesMinor)).toBe(1000n); // store A only, not 1000+9000
    expect(gerantTreasury.supplier).toBeNull(); // never fetched for a store-scoped actor
  });
});
