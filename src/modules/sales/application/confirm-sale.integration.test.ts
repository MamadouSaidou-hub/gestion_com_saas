import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import {
  seedStructure,
  createProduct,
  setStockLevel,
  addMembership,
  readCounts,
  readDocumentCounter,
  setVatRate,
} from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";
import type { ConfirmSaleInput } from "@/modules/sales";

// ---------------------------------------------------------------------------
// confirmSale integration suite -- runs against a disposable
// postgres:16-alpine container (see vitest.integration.config.ts +
// src/test/integration/global-setup.ts for spin-up/teardown). Run with
// `npm run test:integration`, NOT part of the default `npx vitest run`.
//
// Env vars are set explicitly here, BEFORE any dynamic import of
// env-dependent modules below, rather than relying solely on
// `vitest.integration.config.ts`'s `test.env` propagation timing --
// belt-and-suspenders (see that config file's header comment).
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let salesService: typeof import("@/modules/sales").salesService;
let inventoryService: typeof import("@/modules/inventory").inventoryService;
let InsufficientStockError: typeof import("@/modules/inventory").InsufficientStockError;
let ForbiddenError: typeof import("@/platform/errors").ForbiddenError;
let assertCan: typeof import("@/modules/tenancy/permissions").assertCan;
let IdempotencyKeyReuseError: typeof import("@/modules/sales").IdempotencyKeyReuseError;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ salesService, IdempotencyKeyReuseError } = await import("@/modules/sales"));
  ({ inventoryService, InsufficientStockError } = await import("@/modules/inventory"));
  ({ ForbiddenError } = await import("@/platform/errors"));
  ({ assertCan } = await import("@/modules/tenancy/permissions"));
});

function baseInput(overrides: Partial<ConfirmSaleInput> & Pick<ConfirmSaleInput, "warehouseId" | "lines">): ConfirmSaleInput {
  return {
    idempotencyKey: `test-idem-${randomUUID()}`,
    currencyCode: "XOF",
    ...overrides,
  };
}

describe("confirmSale", () => {
  it("(a) idempotency: the same key submitted twice yields exactly one sale/movement/ticket/audit entry", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-A", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "100.0000", 600);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    // Credit (zero-payment) sale -- needs an identified customer per the
    // "any unpaid balance" rule, unrelated to what THIS test actually
    // exercises (idempotency), so just supply one.
    const input = baseInput({
      warehouseId: fixture.warehouseId,
      customerId: fixture.customerId,
      lines: [{ productId, quantity: "2.0000" }],
    });

    const first = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));
    const second = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.ticketNumber).toBe(first.ticketNumber);
    expect(second.totalMinor).toBe(first.totalMinor);
    expect(second.saleId).toBe(first.saleId);

    const counts = await readCounts(fixture, productId);
    expect(counts.salesCount).toBe(1);
    expect(counts.movementsCount).toBe(1);
    expect(counts.auditCount).toBe(1);
    expect(counts.stockQuantity).toBe("98.0000");
  });

  it("(b) atomicity: insufficient stock on the 2nd line rolls back the whole transaction", async () => {
    const fixture = await seedStructure();
    const productA = await createProduct(fixture, { sku: "SKU-B1", priceMinor: 1000, costMinor: 600 });
    const productB = await createProduct(fixture, { sku: "SKU-B2", priceMinor: 2000, costMinor: 1200 });
    await setStockLevel(fixture, productA, "100.0000", 600);
    await setStockLevel(fixture, productB, "1.0000", 1200); // only 1 in stock

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const input = baseInput({
      warehouseId: fixture.warehouseId,
      lines: [
        { productId: productA, quantity: "5.0000" },
        { productId: productB, quantity: "5.0000" }, // exceeds the 1 available
      ],
    });

    await expect(
      withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input))
    ).rejects.toThrow(InsufficientStockError);

    const countsA = await readCounts(fixture, productA);
    expect(countsA.salesCount).toBe(0);
    expect(countsA.movementsCount).toBe(0);
    expect(countsA.auditCount).toBe(0);
    expect(countsA.stockQuantity).toBe("100.0000"); // product A's stock untouched

    const countsB = await readCounts(fixture, productB);
    expect(countsB.stockQuantity).toBe("1.0000"); // product B's stock untouched

    const fiscalYear = new Date().getUTCFullYear();
    expect(await readDocumentCounter(fixture, fiscalYear)).toBeNull(); // no ticket number burned
  });

  it("(c) allocates gapless, duplicate-free ticket numbers under concurrency", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-C", priceMinor: 500, costMinor: 300 });
    await setStockLevel(fixture, productId, "1000.0000", 300);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const N = 8;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withTenantSession(owner, (ctx) =>
          salesService.confirmSale(
            ctx,
            baseInput({
              idempotencyKey: `concurrent-${i}-${randomUUID()}`,
              warehouseId: fixture.warehouseId,
              customerId: fixture.customerId, // credit sale -- needs a customer
              lines: [{ productId, quantity: "1.0000" }],
            })
          )
        )
      )
    );

    const ticketNumbers = results.map((r) => Number(r.ticketNumber)).sort((a, b) => a - b);
    expect(ticketNumbers).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(ticketNumbers).size).toBe(N); // no duplicates
  }, 20_000);

  it("(d) a cashier cannot oversell even when explicitly requesting the override", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-D1", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "1.0000", 600);
    const cashierUserId = await addMembership(fixture, "cashier");
    const cashier: Actor = { userId: cashierUserId, structureId: fixture.structureId, role: "cashier", warehouseId: null };

    const input = baseInput({
      warehouseId: fixture.warehouseId,
      lines: [{ productId, quantity: "5.0000" }],
      allowOversell: true,
    });

    await expect(
      withTenantSession(cashier, (ctx) => salesService.confirmSale(ctx, input))
    ).rejects.toThrow(InsufficientStockError);
  });

  it("(d) a cashier cannot void a sale (direct permission check)", () => {
    const cashier: Actor = { userId: "test-cashier-novoid", structureId: randomUUID(), role: "cashier", warehouseId: null };
    expect(() => assertCan(cashier, "sale:void")).toThrow(ForbiddenError);
  });

  it("(d) an actor without sale:create is refused outright, before touching the DB", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-D2", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "100.0000", 600);

    // 'auditor' has no sale:create in the matrix, and no real membership
    // row is seeded for this actor -- assertCan must throw BEFORE any RLS-
    // gated query is attempted (otherwise this would fail with an RLS
    // error instead of ForbiddenError, which would be the wrong failure
    // mode for this test).
    const auditor: Actor = { userId: "test-auditor-norights", structureId: fixture.structureId, role: "auditor", warehouseId: null };
    const input = baseInput({ warehouseId: fixture.warehouseId, lines: [{ productId, quantity: "1.0000" }] });

    await expect(
      withTenantSession(auditor, (ctx) => salesService.confirmSale(ctx, input))
    ).rejects.toThrow(ForbiddenError);

    const counts = await readCounts(fixture, productId);
    expect(counts.salesCount).toBe(0);
  });

  it("a credit sale (zero payment) persists with payment_status='unpaid' and still decrements stock", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-CREDIT", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const input = baseInput({
      warehouseId: fixture.warehouseId,
      customerId: fixture.customerId,
      lines: [{ productId, quantity: "3.0000" }],
      // no `payment` -- pure credit sale.
    });

    const result = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));

    expect(result.paymentStatus).toBe("unpaid");
    expect(result.paidMinor).toBe("0");
    expect(result.totalMinor).not.toBe("0");

    const counts = await readCounts(fixture, productId);
    expect(counts.stockQuantity).toBe("47.0000"); // 50 - 3, stock left regardless of payment
    expect(counts.salesCount).toBe(1);
    expect(counts.movementsCount).toBe(1);
  });

  it("a partially-paid sale requires an identified customer", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-PARTIAL", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const input = baseInput({
      warehouseId: fixture.warehouseId,
      // no customerId -- anonymous walk-in
      lines: [{ productId, quantity: "2.0000" }], // total = 2000
      payment: { method: "cash", amountMinor: "500" }, // partial
    });

    await expect(
      withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input))
    ).rejects.toThrow(/identified customer/);
  });

  it("an anonymous zero-payment (fully credit) sale is also rejected -- not just the partial case", async () => {
    // Correction (coordinator feedback): a fully-unpaid sale opens a
    // receivable for the WHOLE total, exactly like a partial payment --
    // an earlier version of this rule only guarded the partial case,
    // which was an unintentional gap, not a deliberate asymmetry.
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-ANON-CREDIT", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const input = baseInput({
      warehouseId: fixture.warehouseId,
      // no customerId -- anonymous walk-in
      lines: [{ productId, quantity: "2.0000" }],
      // no `payment` at all -- zero collected, full balance left.
    });

    await expect(
      withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input))
    ).rejects.toThrow(/identified customer/);

    const counts = await readCounts(fixture, productId);
    expect(counts.salesCount).toBe(0); // rejected before commit, full rollback
  });

  it("a fully-paid sale is marked paid and records a payment row", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-PAID", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const input = baseInput({
      warehouseId: fixture.warehouseId,
      lines: [{ productId, quantity: "1.0000" }], // total = 1000 (no VAT configured -> 0%)
      payment: { method: "cash", amountMinor: "1000" },
    });

    const result = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));
    expect(result.paymentStatus).toBe("paid");
    expect(result.paidMinor).toBe(result.totalMinor);
  });

  // H2 (security-reviewer, High): the POS only ever knows the HT subtotal
  // before VAT is applied server-side -- sending a client-computed
  // "total" as `payment.amountMinor` used to fall short of the real TTC
  // total the moment vat_rate > 0, misrouting every "pay in full" cash
  // sale into the credit branch (refused for lack of a customer on ANY
  // VAT-registered shop). `payment.full: true` fixes this by having the
  // SERVER compute the amount from its own totals.
  it("(H2) a full cash sale succeeds on a VAT-registered shop via payment.full", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-H2-VAT", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);
    await setVatRate(fixture, "18.00");

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const input = baseInput({
      warehouseId: fixture.warehouseId,
      lines: [{ productId, quantity: "1.0000" }], // HT = 1000, TTC = 1180
      payment: { method: "cash", full: true },
    });

    const result = await withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));
    expect(result.totalMinor).toBe("1180"); // TTC
    expect(result.paidMinor).toBe("1180"); // server-computed, matches TTC exactly
    expect(result.paymentStatus).toBe("paid");
  });

  // H1 (security-reviewer, High): a reused idempotency key with a
  // DIFFERENT cart must be refused outright, never silently resolved to
  // the original sale.
  it("(H1) replaying an idempotency key with a DIFFERENT cart throws IdempotencyKeyReuseError", async () => {
    const fixture = await seedStructure();
    const productA = await createProduct(fixture, { sku: "SKU-H1-A", priceMinor: 1000, costMinor: 600 });
    const productB = await createProduct(fixture, { sku: "SKU-H1-B", priceMinor: 2000, costMinor: 1200 });
    await setStockLevel(fixture, productA, "50.0000", 600);
    await setStockLevel(fixture, productB, "50.0000", 1200);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const sharedKey = `test-h1-${randomUUID()}`;

    const first = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(
        ctx,
        baseInput({
          idempotencyKey: sharedKey,
          warehouseId: fixture.warehouseId,
          customerId: fixture.customerId,
          lines: [{ productId: productA, quantity: "1.0000" }],
        })
      )
    );
    expect(first.replayed).toBe(false);

    // SAME key, DIFFERENT cart (product B instead of A).
    await expect(
      withTenantSession(owner, (ctx) =>
        salesService.confirmSale(
          ctx,
          baseInput({
            idempotencyKey: sharedKey,
            warehouseId: fixture.warehouseId,
            customerId: fixture.customerId,
            lines: [{ productId: productB, quantity: "1.0000" }],
          })
        )
      )
    ).rejects.toThrow(IdempotencyKeyReuseError);

    // The SAME key with the SAME original cart still replays cleanly.
    const replay = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(
        ctx,
        baseInput({
          idempotencyKey: sharedKey,
          warehouseId: fixture.warehouseId,
          customerId: fixture.customerId,
          lines: [{ productId: productA, quantity: "1.0000" }],
        })
      )
    );
    expect(replay.replayed).toBe(true);
    expect(replay.saleId).toBe(first.saleId);

    // No duplicate/ghost sale was created by the mismatched attempt.
    const counts = await readCounts(fixture, productA);
    expect(counts.salesCount).toBe(1);
  });

  // H3 (security-reviewer, High): a concurrent sale and a manual stock
  // adjustment on the SAME product must not lose either effect. Before
  // the fix, `adjustStock` read `stock_levels` without `FOR UPDATE` then
  // wrote an ABSOLUTE quantity -- it could silently overwrite the sale's
  // decrement (or vice versa), inflating/deflating available stock.
  it("(H3) a concurrent sale and stock adjustment on the same product both land", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-H3", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "100.0000", 600);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    const [saleResult, adjustResult] = await Promise.all([
      withTenantSession(owner, (ctx) =>
        salesService.confirmSale(
          ctx,
          baseInput({
            warehouseId: fixture.warehouseId,
            customerId: fixture.customerId,
            lines: [{ productId, quantity: "10.0000" }],
          })
        )
      ),
      withTenantSession(owner, (ctx) =>
        inventoryService.adjustStock(ctx, {
          productId,
          warehouseId: fixture.warehouseId,
          direction: "out",
          quantity: "5.0000",
          currencyCode: "XOF",
          reason: "breakage",
        })
      ),
    ]);

    expect(saleResult.replayed).toBe(false);
    expect(adjustResult.quantity).toBe("5.0000");

    const counts = await readCounts(fixture, productId);
    // 100 - 10 (sale) - 5 (adjustment) = 85. If either write had been lost
    // to the other (the pre-fix race), this would read 90 or 95 instead.
    expect(counts.stockQuantity).toBe("85.0000");
  });
});
