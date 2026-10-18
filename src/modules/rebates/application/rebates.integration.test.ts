import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import {
  seedStructure,
  createProduct,
  createSupplier,
  backdateSaleConfirmedAt,
  setStockLevel,
} from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";

// ---------------------------------------------------------------------------
// Rebates (generic, quantity-driven, cliff-mode) -- same disposable-
// container convention as billing/purchasing integration suites.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let rebatesService: typeof import("@/modules/rebates").rebatesService;
let purchasingService: typeof import("@/modules/purchasing").purchasingService;
let salesService: typeof import("@/modules/sales").salesService;
let billingService: typeof import("@/modules/billing").billingService;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ rebatesService } = await import("@/modules/rebates"));
  ({ purchasingService } = await import("@/modules/purchasing"));
  ({ salesService } = await import("@/modules/sales"));
  ({ billingService } = await import("@/modules/billing"));
});

function ownerOf(fixture: Awaited<ReturnType<typeof seedStructure>>): Actor {
  return { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
}

async function confirmSaleForCustomer(
  fixture: Awaited<ReturnType<typeof seedStructure>>,
  productId: string,
  quantity: string
) {
  const owner = ownerOf(fixture);
  return withTenantSession(owner, (ctx) =>
    salesService.confirmSale(ctx, {
      idempotencyKey: `test-idem-${randomUUID()}`,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      customerId: fixture.customerId,
      lines: [{ productId, quantity }],
    })
  );
}

async function recordDeliveryAndCheckRebate(
  fixture: Awaited<ReturnType<typeof seedStructure>>,
  supplierId: string,
  productId: string,
  quantity: string
) {
  const owner = ownerOf(fixture);
  // Mirrors purchasing/api/actions.ts's recordDeliveryAction composition:
  // both calls share the SAME ctx/transaction.
  return withTenantSession(owner, async (ctx) => {
    const delivery = await purchasingService.recordDelivery(ctx, {
      idempotencyKey: `test-delivery-${randomUUID()}`,
      supplierId,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      lines: [{ productId, quantity, unitCostMinor: "1000" }],
    });
    const grant = await rebatesService.checkAndGrantSupplierTier(ctx, { supplierId });
    return { delivery, grant };
  });
}

describe("rebates: customer side (monthly, cliff mode)", () => {
  it("cliff mode rebates ALL counted units, not just the units above the threshold", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-REB-1", priceMinor: 100, costMinor: 0 });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        customerId: fixture.customerId,
        currencyCode: "XOF",
        tiers: [
          { thresholdQty: "10", rebatePerUnitMinor: "5" },
          { thresholdQty: "50", rebatePerUnitMinor: "20" },
        ],
      })
    );

    // 60 units this month -- crosses BOTH tiers, highest reached (50) wins.
    await setStockLevel(fixture, productId, "100.0000", 0);
    await confirmSaleForCustomer(fixture, productId, "60.0000");

    const grant = await withTenantSession(owner, (ctx) => rebatesService.calculateCustomerRebate(ctx, fixture.customerId));
    expect(grant).not.toBeNull();
    expect(grant?.countedQty).toBe("60.0000");
    expect(grant?.tierThresholdQty).toBe("50.0000");
    // Cliff mode: ALL 60 units at the 50-tier's rate (20/unit) = 1200, NOT
    // just the 10 units above the 50 threshold (which would be 200).
    expect(grant?.totalRebateMinor).toBe("1200");
  });

  it("the month rolls over with no stored counter -- last month's units don't count", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-REB-2", priceMinor: 100, costMinor: 0 });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        customerId: fixture.customerId,
        currencyCode: "XOF",
        tiers: [{ thresholdQty: "10", rebatePerUnitMinor: "5" }],
      })
    );

    // A sale confirmed "last month" (backdated) -- must NOT count toward
    // THIS month's tally. The period is derived from now() every call,
    // never a stored counter, so this is the direct proof of that property.
    await setStockLevel(fixture, productId, "200.0000", 0);
    const lastMonthSale = await confirmSaleForCustomer(fixture, productId, "100.0000");
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await backdateSaleConfirmedAt(fixture, lastMonthSale.saleId, lastMonth);

    const grantBefore = await withTenantSession(owner, (ctx) =>
      rebatesService.calculateCustomerRebate(ctx, fixture.customerId)
    );
    expect(grantBefore).toBeNull(); // nothing THIS month yet -- no write

    // A sale confirmed THIS month, below the threshold on its own.
    await confirmSaleForCustomer(fixture, productId, "5.0000");
    const grantStillNull = await withTenantSession(owner, (ctx) =>
      rebatesService.calculateCustomerRebate(ctx, fixture.customerId)
    );
    expect(grantStillNull).toBeNull();
  });

  it("calculateCustomerRebate upserts the SAME row for the same month (race-safe), not a duplicate", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-REB-3", priceMinor: 100, costMinor: 0 });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        customerId: fixture.customerId,
        currencyCode: "XOF",
        tiers: [{ thresholdQty: "10", rebatePerUnitMinor: "5" }],
      })
    );
    await setStockLevel(fixture, productId, "100.0000", 0);
    await confirmSaleForCustomer(fixture, productId, "20.0000");

    const [grantA, grantB] = await Promise.all([
      withTenantSession(owner, (ctx) => rebatesService.calculateCustomerRebate(ctx, fixture.customerId)),
      withTenantSession(owner, (ctx) => rebatesService.calculateCustomerRebate(ctx, fixture.customerId)),
    ]);
    expect(grantA?.id).toBe(grantB?.id); // same row, not two
  });

  it("a rebate grant is informational only -- the customer's receivable is unchanged", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-REB-4", priceMinor: 1000, costMinor: 0 });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        customerId: fixture.customerId,
        currencyCode: "XOF",
        tiers: [{ thresholdQty: "1", rebatePerUnitMinor: "100" }],
      })
    );

    const receivablesBefore = await withTenantSession(owner, (ctx) => billingService.getReceivables(ctx));

    await setStockLevel(fixture, productId, "50.0000", 0);
    await confirmSaleForCustomer(fixture, productId, "5.0000"); // credit sale, opens a receivable
    const receivablesAfterSale = await withTenantSession(owner, (ctx) => billingService.getReceivables(ctx));
    expect(receivablesAfterSale.totalOutstandingMinor).not.toBe(receivablesBefore.totalOutstandingMinor);

    const grant = await withTenantSession(owner, (ctx) => rebatesService.calculateCustomerRebate(ctx, fixture.customerId));
    expect(grant).not.toBeNull();

    const receivablesAfterGrant = await withTenantSession(owner, (ctx) => billingService.getReceivables(ctx));
    // The grant itself must not move the receivable by a single minor unit.
    expect(receivablesAfterGrant.totalOutstandingMinor).toBe(receivablesAfterSale.totalOutstandingMinor);
  });
});

describe("rebates: supplier side (cyclic, auto-triggered)", () => {
  it("auto-triggers inside recordDelivery's transaction and grants the highest tier reached", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Reb" });
    const productId = await createProduct(fixture, { sku: "SKU-SREB-1", priceMinor: 100, costMinor: 0 });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        supplierId,
        currencyCode: "XOF",
        tiers: [
          { thresholdQty: "20", rebatePerUnitMinor: "10" },
          { thresholdQty: "40", rebatePerUnitMinor: "30" },
        ],
      })
    );

    const { grant } = await recordDeliveryAndCheckRebate(fixture, supplierId, productId, "50.0000");
    expect(grant).not.toBeNull();
    expect(grant?.tierThresholdQty).toBe("40.0000");
    expect(grant?.totalRebateMinor).toBe("1500"); // 50 * 30, cliff mode

    // A SECOND delivery that does not cross a NEW tier is a no-op.
    const { grant: secondGrant } = await recordDeliveryAndCheckRebate(fixture, supplierId, productId, "1.0000");
    expect(secondGrant).toBeNull();
  });

  it("two concurrent deliveries crossing a threshold grant exactly once", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Concurrent" });
    const productId = await createProduct(fixture, { sku: "SKU-SREB-2", priceMinor: 100, costMinor: 0 });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        supplierId,
        currencyCode: "XOF",
        tiers: [{ thresholdQty: "20", rebatePerUnitMinor: "10" }],
      })
    );

    // Two concurrent deliveries, each crossing the 20-unit threshold alone.
    const [resultA, resultB] = await Promise.all([
      recordDeliveryAndCheckRebate(fixture, supplierId, productId, "25.0000"),
      recordDeliveryAndCheckRebate(fixture, supplierId, productId, "25.0000"),
    ]);

    const grants = [resultA.grant, resultB.grant].filter((g) => g !== null);
    expect(grants).toHaveLength(1); // exactly one grant, not zero and not two

    const scale = await withTenantSession(owner, (ctx) => rebatesService.getSupplierRebateProgress(ctx, supplierId));
    expect(scale?.countedQty).toBe("50.0000"); // both deliveries counted toward the cycle
  });

  it("verifyRebateTier (manual) is a no-op -- no write, no audit -- when no new threshold is met", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Manuel" });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        supplierId,
        currencyCode: "XOF",
        tiers: [{ thresholdQty: "20", rebatePerUnitMinor: "10" }],
      })
    );

    const grant = await withTenantSession(owner, (ctx) => rebatesService.verifyRebateTier(ctx, { supplierId }));
    expect(grant).toBeNull(); // zero units delivered -- below every threshold
  });

  it("a rebate grant is informational only -- the supplier's debt is unchanged", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Debt Unchanged" });
    const productId = await createProduct(fixture, { sku: "SKU-SREB-3", priceMinor: 1000, costMinor: 0 });
    const owner = ownerOf(fixture);

    await withTenantSession(owner, (ctx) =>
      rebatesService.createRebateScale(ctx, {
        supplierId,
        currencyCode: "XOF",
        tiers: [{ thresholdQty: "1", rebatePerUnitMinor: "50" }],
      })
    );

    const debtBefore = await withTenantSession(owner, (ctx) => purchasingService.getSupplierDebt(ctx, supplierId));

    const { grant } = await recordDeliveryAndCheckRebate(fixture, supplierId, productId, "5.0000");
    expect(grant).not.toBeNull();

    const debtAfter = await withTenantSession(owner, (ctx) => purchasingService.getSupplierDebt(ctx, supplierId));
    // The delivery itself opens debt (5 * 1000 = 5000); the GRANT must not
    // move it by a single minor unit beyond what the delivery alone caused.
    expect(debtAfter.debtMinor).toBe((BigInt(debtBefore.debtMinor) + 5000n).toString());
  });
});
