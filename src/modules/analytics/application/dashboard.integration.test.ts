import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import {
  seedStructure,
  createProduct,
  setStockLevel,
  addMembership,
  backdateSaleConfirmedAt,
  cancelSaleDirect,
  setVatRate,
} from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";
import type { ConfirmSaleInput } from "@/modules/sales";

// ---------------------------------------------------------------------------
// Dashboard money-definition edge cases (Phase 1 step 5) -- the ones that
// are easy to get wrong and expensive to get wrong, per the coordinator's
// explicit instruction. Same disposable-container convention as the
// sales/billing integration suites.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let salesService: typeof import("@/modules/sales").salesService;
let billingService: typeof import("@/modules/billing").billingService;
let analyticsService: typeof import("@/modules/analytics").analyticsService;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ salesService } = await import("@/modules/sales"));
  ({ billingService } = await import("@/modules/billing"));
  ({ analyticsService } = await import("@/modules/analytics"));
});

async function makeFixtureWithProduct(priceMinor = 1000, costMinor = 600) {
  const fixture = await seedStructure();
  const productId = await createProduct(fixture, { sku: `SKU-${randomUUID()}`, priceMinor, costMinor });
  await setStockLevel(fixture, productId, "1000.0000", costMinor);
  return { fixture, productId };
}

function ownerActor(fixture: Awaited<ReturnType<typeof seedStructure>>): Actor {
  return { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };
}

describe("dashboard money definitions", () => {
  it("(1) a credit sale raises CA but not encaissé, and shows in en attente", async () => {
    const { fixture, productId } = await makeFixtureWithProduct();
    const owner = ownerActor(fixture);
    const input: ConfirmSaleInput = {
      idempotencyKey: `test-idem-${randomUUID()}`,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      customerId: fixture.customerId,
      lines: [{ productId, quantity: "2.0000" }], // total = 2000, 0% VAT
    };
    const sale = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));

    const dashboard = await withTenantSession(owner, (ctx) =>
      analyticsService.getDashboard(ctx, { period: "day" })
    );

    expect(dashboard.financials).toBeDefined();
    expect(BigInt(dashboard.financials!.caBrutMinor)).toBeGreaterThanOrEqual(BigInt(sale.totalMinor));
    expect(BigInt(dashboard.financials!.caNetMinor)).toBeGreaterThanOrEqual(BigInt(sale.totalMinor));
    expect(dashboard.financials!.encaisseMinor).toBe("0"); // nothing collected
    expect(BigInt(dashboard.financials!.receivables.totalOutstandingMinor)).toBeGreaterThanOrEqual(
      BigInt(sale.totalMinor)
    );
  });

  it("(2) a payment received today against last month's sale lands in today's encaissé, not today's CA", async () => {
    const { fixture, productId } = await makeFixtureWithProduct();
    const owner = ownerActor(fixture);
    const input: ConfirmSaleInput = {
      idempotencyKey: `test-idem-${randomUUID()}`,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      customerId: fixture.customerId,
      lines: [{ productId, quantity: "1.0000" }], // total = 1000
    };
    const sale = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));

    // Backdate the sale to a month ago so it falls OUTSIDE today's window.
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await backdateSaleConfirmedAt(fixture, sale.saleId, lastMonth);

    // Collect payment TODAY.
    await withTenantSession(owner, (ctx) =>
      billingService.recordPayment(ctx, {
        idempotencyKey: `test-payment-${randomUUID()}`,
        amountMinor: "1000",
        method: "cash",
        saleId: sale.saleId,
      })
    );

    const dashboard = await withTenantSession(owner, (ctx) =>
      analyticsService.getDashboard(ctx, { period: "day" })
    );

    // Today's encaissé includes the payment (received_at = today).
    expect(BigInt(dashboard.financials!.encaisseMinor)).toBeGreaterThanOrEqual(1000n);
    // Today's CA does NOT include the backdated sale (confirmed_at = last month).
    expect(dashboard.financials!.caBrutMinor).toBe("0");
    expect(dashboard.financials!.caNetMinor).toBe("0");
  });

  it("(3) a partially-paid sale splits correctly between encaissé and en attente", async () => {
    const { fixture, productId } = await makeFixtureWithProduct();
    const owner = ownerActor(fixture);
    const input: ConfirmSaleInput = {
      idempotencyKey: `test-idem-${randomUUID()}`,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      customerId: fixture.customerId,
      lines: [{ productId, quantity: "2.0000" }], // total = 2000
    };
    const sale = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));

    await withTenantSession(owner, (ctx) =>
      billingService.recordPayment(ctx, {
        idempotencyKey: `test-payment-${randomUUID()}`,
        amountMinor: "800",
        method: "mobile_money",
        saleId: sale.saleId,
      })
    );

    const dashboard = await withTenantSession(owner, (ctx) =>
      analyticsService.getDashboard(ctx, { period: "day" })
    );

    expect(BigInt(dashboard.financials!.encaisseMinor)).toBeGreaterThanOrEqual(800n);
    // Outstanding balance for THIS sale is 2000 - 800 = 1200, part of the
    // (possibly larger, multi-fixture-independent) total outstanding.
    expect(BigInt(dashboard.financials!.receivables.totalOutstandingMinor)).toBeGreaterThanOrEqual(1200n);

    const methodRow = dashboard.financials!.encaisseByMethod.find((m) => m.method === "mobile_money");
    expect(methodRow).toBeDefined();
    expect(BigInt(methodRow!.amountMinor)).toBeGreaterThanOrEqual(800n);
  });

  it("(4) a cancelled sale drops out of CA net but stays in CA brut", async () => {
    const { fixture, productId } = await makeFixtureWithProduct();
    const owner = ownerActor(fixture);
    const input: ConfirmSaleInput = {
      idempotencyKey: `test-idem-${randomUUID()}`,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      lines: [{ productId, quantity: "1.0000" }], // total = 1000
      payment: { method: "cash", amountMinor: "1000" }, // fully paid, anonymous ok
    };
    const sale = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));

    const before = await withTenantSession(owner, (ctx) =>
      analyticsService.getDashboard(ctx, { period: "day" })
    );
    const grossBefore = BigInt(before.financials!.caBrutMinor);
    const netBefore = BigInt(before.financials!.caNetMinor);

    await cancelSaleDirect(fixture, sale.saleId);

    const after = await withTenantSession(owner, (ctx) =>
      analyticsService.getDashboard(ctx, { period: "day" })
    );

    // CA brut is unchanged (confirmed_at is still in window, regardless of
    // current status) -- CA net drops by exactly this sale's total
    // (status is no longer 'confirmed').
    expect(BigInt(after.financials!.caBrutMinor)).toBe(grossBefore);
    expect(BigInt(after.financials!.caNetMinor)).toBe(netBefore - BigInt(sale.totalMinor));
  });

  it("(5) a cashier's dashboard response contains no financial fields at all", async () => {
    const { fixture } = await makeFixtureWithProduct();
    const cashierUserId = await addMembership(fixture, "cashier");
    const cashier: Actor = { userId: cashierUserId, structureId: fixture.structureId, role: "cashier" };

    const dashboard = await withTenantSession(cashier, (ctx) =>
      analyticsService.getDashboard(ctx, { period: "day" })
    );

    expect(dashboard.financials).toBeUndefined();
    expect(typeof dashboard.ownSaleCount).toBe("number");
    expect(typeof dashboard.ownTotalMinor).toBe("string");
    expect(Array.isArray(dashboard.lowStockAlerts)).toBe(true);
    // Not even present as a key (never assigned), per "don't fetch what
    // the actor may not see" -- not just `undefined` after serialization.
    expect(Object.prototype.hasOwnProperty.call(dashboard, "financials")).toBe(false);
  });

  it("(correction) margin is computed HT (net-of-VAT), not TTC", async () => {
    const { fixture, productId } = await makeFixtureWithProduct(1000, 600); // price HT = 1000, cost = 600
    await setVatRate(fixture, "18.00");
    const owner = ownerActor(fixture);

    const input: ConfirmSaleInput = {
      idempotencyKey: `test-idem-${randomUUID()}`,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      lines: [{ productId, quantity: "1.0000" }], // lineTotalMinor (TTC) = 1180
      payment: { method: "cash", amountMinor: "1180" },
    };
    await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));

    const dashboard = await withTenantSession(owner, (ctx) =>
      analyticsService.getDashboard(ctx, { period: "day" })
    );

    // HT revenue = 1000 (not 1180 TTC) -- margin = 1000 - 600 = 400, not
    // the TTC-inflated 580 a pre-correction implementation would report.
    expect(dashboard.financials!.margin.revenueMinor).toBe("1000");
    expect(dashboard.financials!.margin.costMinor).toBe("600");
    expect(dashboard.financials!.margin.marginMinor).toBe("400");
  });
});
