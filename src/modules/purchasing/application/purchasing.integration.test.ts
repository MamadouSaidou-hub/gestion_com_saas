import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import { seedStructure, createProduct, createSupplier } from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";

// ---------------------------------------------------------------------------
// Purchasing (supplier deliveries + supplier payments, migration 0015) --
// same disposable-container convention as billing.integration.test.ts.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let purchasingService: typeof import("@/modules/purchasing").purchasingService;
let SupplierPaymentAlreadyVoidedErrorCtor: typeof import("@/modules/purchasing").SupplierPaymentAlreadyVoidedError;
let inventoryService: typeof import("@/modules/inventory").inventoryService;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ purchasingService, SupplierPaymentAlreadyVoidedError: SupplierPaymentAlreadyVoidedErrorCtor } =
    await import("@/modules/purchasing"));
  ({ inventoryService } = await import("@/modules/inventory"));
});

async function recordDelivery(
  fixture: Awaited<ReturnType<typeof seedStructure>>,
  supplierId: string,
  productId: string,
  quantity: string,
  unitCostMinor: string
) {
  const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
  return withTenantSession(owner, (ctx) =>
    purchasingService.recordDelivery(ctx, {
      idempotencyKey: `test-delivery-${randomUUID()}`,
      supplierId,
      warehouseId: fixture.warehouseId,
      currencyCode: "XOF",
      lines: [{ productId, quantity, unitCostMinor }],
    })
  );
}

describe("purchasing: supplier deliveries", () => {
  it("recordDelivery feeds CUMP via inventory's stock_levels projection", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Grossiste Test" });
    const productId = await createProduct(fixture, { sku: "SKU-DELIV-1", priceMinor: 1000, costMinor: 0 });

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    const delivery = await recordDelivery(fixture, supplierId, productId, "10.0000", "500");
    expect(delivery.totalMinor).toBe("5000"); // 10 * 500
    expect(delivery.paymentStatus).toBe("unpaid");
    expect(delivery.lines[0].lineTotalMinor).toBe("5000");

    const levels = await withTenantSession(owner, (ctx) =>
      inventoryService.getStockLevels(ctx, { warehouseId: fixture.warehouseId, productIds: [productId] })
    );
    expect(levels[0]?.quantity).toBe("10.0000");
    expect(levels[0]?.avgCostMinor).toBe("500"); // first receipt -- CUMP = unit cost

    // A second delivery at a different cost blends into the moving average.
    const delivery2 = await recordDelivery(fixture, supplierId, productId, "10.0000", "700");
    expect(delivery2.totalMinor).toBe("7000");
    const levels2 = await withTenantSession(owner, (ctx) =>
      inventoryService.getStockLevels(ctx, { warehouseId: fixture.warehouseId, productIds: [productId] })
    );
    expect(levels2[0]?.quantity).toBe("20.0000");
    expect(levels2[0]?.avgCostMinor).toBe("600"); // (10*500 + 10*700) / 20 = 600
  });

  it("recordDelivery opens a debt (unpaid) whose total feeds getSupplierDebt", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Debt" });
    const productId = await createProduct(fixture, { sku: "SKU-DELIV-2", priceMinor: 1000, costMinor: 0 });
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    await recordDelivery(fixture, supplierId, productId, "4.0000", "1000"); // total 4000

    const debt = await withTenantSession(owner, (ctx) => purchasingService.getSupplierDebt(ctx, supplierId));
    expect(debt.debtMinor).toBe("4000");
  });

  it("(C1) two concurrent recordSupplierPayment calls on the same delivery both land -- no lost update", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur C1 Pay" });
    const productId = await createProduct(fixture, { sku: "SKU-C1-PAY", priceMinor: 1000, costMinor: 0 });
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    const delivery = await recordDelivery(fixture, supplierId, productId, "10.0000", "1000"); // total 10000

    const [paymentA, paymentB] = await Promise.all([
      withTenantSession(owner, (ctx) =>
        purchasingService.recordSupplierPayment(ctx, {
          idempotencyKey: `concurrent-sp-a-${randomUUID()}`,
          supplierId,
          deliveryId: delivery.id,
          amountMinor: "4000",
          method: "cash",
        })
      ),
      withTenantSession(owner, (ctx) =>
        purchasingService.recordSupplierPayment(ctx, {
          idempotencyKey: `concurrent-sp-b-${randomUUID()}`,
          supplierId,
          deliveryId: delivery.id,
          amountMinor: "4000",
          method: "mobile_money",
        })
      ),
    ]);

    expect(paymentA.id).not.toBe(paymentB.id);

    const debt = await withTenantSession(owner, (ctx) => purchasingService.getSupplierDebt(ctx, supplierId));
    // 10000 - 4000 - 4000 = 2000, NOT 10000 - 4000 = 6000 (the lost-update symptom).
    expect(debt.debtMinor).toBe("2000");
  });

  it("(C1) two concurrent voidSupplierPayment calls on the same payment debit the balance exactly once", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur C1 Void" });
    const productId = await createProduct(fixture, { sku: "SKU-C1-VOID", priceMinor: 1000, costMinor: 0 });
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    const delivery = await recordDelivery(fixture, supplierId, productId, "5.0000", "1000"); // total 5000
    const payment = await withTenantSession(owner, (ctx) =>
      purchasingService.recordSupplierPayment(ctx, {
        idempotencyKey: `test-sp-${randomUUID()}`,
        supplierId,
        deliveryId: delivery.id,
        amountMinor: "5000",
        method: "cash",
      })
    );

    const debtAfterPay = await withTenantSession(owner, (ctx) => purchasingService.getSupplierDebt(ctx, supplierId));
    expect(debtAfterPay.debtMinor).toBe("0");

    const results = await Promise.allSettled([
      withTenantSession(owner, (ctx) => purchasingService.voidSupplierPayment(ctx, payment.id)),
      withTenantSession(owner, (ctx) => purchasingService.voidSupplierPayment(ctx, payment.id)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const finalDebt = await withTenantSession(owner, (ctx) => purchasingService.getSupplierDebt(ctx, supplierId));
    // Debited (reversed) ONCE: debt goes back to 5000, never below 0 and
    // never double-reversed to -5000.
    expect(finalDebt.debtMinor).toBe("5000");
  });

  it("a store-scoped actor (gerant) cannot record or void a supplier payment", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Gerant" });
    const productId = await createProduct(fixture, { sku: "SKU-GERANT", priceMinor: 1000, costMinor: 0 });
    const delivery = await recordDelivery(fixture, supplierId, productId, "1.0000", "1000");

    const gerant: Actor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "manager",
      warehouseId: fixture.warehouseId, // store-scoped -- a "gerant"
    };

    await expect(
      withTenantSession(gerant, (ctx) =>
        purchasingService.recordSupplierPayment(ctx, {
          idempotencyKey: `test-sp-${randomUUID()}`,
          supplierId,
          deliveryId: delivery.id,
          amountMinor: "1000",
          method: "cash",
        })
      )
    ).rejects.toThrow();
  });

  it("voidSupplierPayment on an already-voided payment throws", async () => {
    const fixture = await seedStructure();
    const supplierId = await createSupplier(fixture, { name: "Fournisseur Double Void" });
    const productId = await createProduct(fixture, { sku: "SKU-DOUBLEVOID", priceMinor: 1000, costMinor: 0 });
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const delivery = await recordDelivery(fixture, supplierId, productId, "1.0000", "1000");
    const payment = await withTenantSession(owner, (ctx) =>
      purchasingService.recordSupplierPayment(ctx, {
        idempotencyKey: `test-sp-${randomUUID()}`,
        supplierId,
        deliveryId: delivery.id,
        amountMinor: "1000",
        method: "cash",
      })
    );
    await withTenantSession(owner, (ctx) => purchasingService.voidSupplierPayment(ctx, payment.id));
    await expect(
      withTenantSession(owner, (ctx) => purchasingService.voidSupplierPayment(ctx, payment.id))
    ).rejects.toThrow(SupplierPaymentAlreadyVoidedErrorCtor);
  });
});
