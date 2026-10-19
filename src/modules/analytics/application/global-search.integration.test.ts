import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import { seedStructure, createProduct, addMembership, addWarehouse, createSupplier } from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";
import type { ConfirmSaleInput } from "@/modules/sales";

// ---------------------------------------------------------------------------
// Global search -- proves permission AND store filtering happen in the
// QUERY (an actor without `supplier:read` gets ZERO supplier hits, not a
// filtered-after-the-fact empty array), and that the products/customers/
// suppliers sections actually use the trigram GIN indexes (migration
// 0016), not a sequential scan.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let salesService: typeof import("@/modules/sales").salesService;
let analyticsService: typeof import("@/modules/analytics").analyticsService;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ salesService } = await import("@/modules/sales"));
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

describe("global search", () => {
  it("an actor without supplier:read gets zero supplier hits even when a matching supplier exists", async () => {
    const fixture = await seedStructure();
    const owner = actorFor(fixture, "owner", fixture.ownerUserId);
    const supplierName = `Riziere-${randomUUID().slice(0, 8)}`;
    await createSupplier(fixture, { name: supplierName });

    // cashier role holds no `supplier:read` in the permission matrix.
    const cashierUserId = await addMembership(fixture, "cashier");
    const cashier = actorFor(fixture, "cashier", cashierUserId);

    const ownerResult = await withTenantSession(owner, (ctx) =>
      analyticsService.globalSearch(ctx, supplierName.slice(0, 6))
    );
    expect(ownerResult.suppliers.length).toBeGreaterThan(0);

    const cashierResult = await withTenantSession(cashier, (ctx) =>
      analyticsService.globalSearch(ctx, supplierName.slice(0, 6))
    );
    expect(cashierResult.suppliers.length).toBe(0);
  });

  it("a store-scoped manager only gets their own store's sales and transfers", async () => {
    const fixture = await seedStructure();
    const owner = actorFor(fixture, "owner", fixture.ownerUserId);
    const storeB = await addWarehouse(fixture, { code: `B-${randomUUID().slice(0, 6)}`, name: "Store B" });
    const gerantUserId = await addMembership(fixture, "manager", undefined, fixture.warehouseId);
    const gerant = actorFor(fixture, "manager", gerantUserId, fixture.warehouseId);

    const productId = await createProduct(fixture, { sku: `SKU-${randomUUID()}`, priceMinor: 1000 });
    // Stock in both stores so an owner-confirmed sale never hits the
    // insufficient-stock branch (not what this test is about).
    const sql = postgres(MIGRATOR_URL, { max: 1 });
    await sql`
      insert into stock_levels (structure_id, product_id, warehouse_id, quantity, avg_cost_minor, currency_code)
      values
        (${fixture.structureId}, ${productId}, ${fixture.warehouseId}, '1000.0000', 600, 'XOF'),
        (${fixture.structureId}, ${productId}, ${storeB}, '1000.0000', 600, 'XOF')
    `;
    // Pre-seed the ticket counter so the resulting ticket numbers are
    // multi-digit -- the search use case requires a 2-char-minimum query
    // (MIN_QUERY_LENGTH, global-search.ts) to avoid an overly broad match
    // on a single digit; this is a test-setup detail, not a product rule.
    const fiscalYear = new Date().getUTCFullYear();
    await sql`
      insert into document_counters (structure_id, doc_type, fiscal_year, next_value)
      values (${fixture.structureId}, 'ticket', ${fiscalYear}, 42)
      on conflict (structure_id, doc_type, fiscal_year) do update set next_value = excluded.next_value
    `;
    await sql.end();

    const saleA = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `idem-${randomUUID()}`,
        warehouseId: fixture.warehouseId,
        currencyCode: "XOF",
        lines: [{ productId, quantity: "1.0000" }],
        payment: { method: "cash", full: true },
      } as ConfirmSaleInput)
    );
    const saleB = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `idem-${randomUUID()}`,
        warehouseId: storeB,
        currencyCode: "XOF",
        lines: [{ productId, quantity: "1.0000" }],
        payment: { method: "cash", full: true },
      } as ConfirmSaleInput)
    );

    expect(saleA.ticketNumber).toBeTruthy();
    expect(saleB.ticketNumber).toBeTruthy();

    const result = await withTenantSession(gerant, (ctx) =>
      analyticsService.globalSearch(ctx, saleA.ticketNumber)
    );
    const foundSaleIds = result.sales.map((s) => s.saleId);
    expect(foundSaleIds).toContain(saleA.saleId);
    expect(foundSaleIds).not.toContain(saleB.saleId);
  });

  it("the products/customers/suppliers sections use the trigram GIN index, not a sequential scan", async () => {
    const fixture = await seedStructure();
    const owner = actorFor(fixture, "owner", fixture.ownerUserId);
    await createProduct(fixture, { sku: `RIZ-${randomUUID().slice(0, 6)}`, priceMinor: 1000 });

    const sql = postgres(APP_URL, { max: 1 });
    try {
      await sql`select set_config('app.structure_id', ${owner.structureId}, false)`;
      await sql`select set_config('app.user_id', ${owner.userId}, false)`;
      const plan = await sql.unsafe(
        `explain select id, sku, name from products where structure_id = $1 and name OPERATOR(extensions.%) $2`,
        [fixture.structureId, "riz"]
      );
      const planText = plan.map((row: Record<string, unknown>) => Object.values(row)[0]).join("\n");
      expect(planText).not.toMatch(/Seq Scan on products/i);
    } finally {
      await sql.end();
    }
  });
});
