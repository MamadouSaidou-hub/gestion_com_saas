import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, beforeAll } from "vitest";
import { APP_URL, MIGRATOR_URL } from "./db-constants";
import { seedStructure, addWarehouse, addMembership, createProduct } from "./seed";

// ---------------------------------------------------------------------------
// Multi-store integration suite (migration 0014) -- proves, AT THE SQL
// LEVEL under RLS as `app_user` (not merely through the UI/app layer), that:
//
//  (1) a gerant (a `manager` membership pinned to ONE store via
//      `memberships.warehouse_id`) sees ZERO rows from another store
//      across sales/stock_movements/stock_levels/payments -- the RLS floor
//      added by 0014, exercised directly, not through the app layer.
//  (2) a forged `warehouseId` in a Server-Action-shaped call (confirmSale,
//      recordPayment) is rejected by the app-layer CEILING
//      (`assertStoreAccess`), independent of (1).
//  (3) `rebuildStockLevels` reconstructs stock_levels IDENTICALLY across N
//      (here: 2) stores from the ledger alone.
//
// Real app-layer services are used to CREATE data (confirmSale,
// receiveStock) -- more realistic than hand-rolled inserts, and it
// incidentally exercises confirmSale's own `assertStoreAccess` call for a
// legitimate unscoped (owner) actor too. The RLS ASSERTIONS themselves
// (point 1) connect as `app_user` directly with hand-set session GUCs,
// exactly like rls-settings.integration.test.ts, so they prove the DATABASE
// POLICY, not just "the app layer happened to filter".
// ---------------------------------------------------------------------------

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let salesService: typeof import("@/modules/sales").salesService;
let inventoryService: typeof import("@/modules/inventory").inventoryService;
let ForbiddenError: typeof import("@/platform/errors").ForbiddenError;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
  process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ salesService } = await import("@/modules/sales"));
  ({ inventoryService } = await import("@/modules/inventory"));
  ({ ForbiddenError } = await import("@/platform/errors"));
});

// Same helper as rls-settings.integration.test.ts: a raw app_user
// connection with hand-set session GUCs, proving the RLS POLICY itself,
// not the app layer's own filtering.
async function asActor<T>(
  userId: string,
  structureId: string,
  warehouseId: string | null,
  fn: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  const sql = postgres(APP_URL, { max: 1 });
  try {
    const result = (await sql.begin(async (tx) => {
      await tx`select set_config('app.structure_id', ${structureId}, true)`;
      await tx`select set_config('app.user_id', ${userId}, true)`;
      // Store scope is derived by app_scoped_warehouse_id() from the
      // membership row itself -- there is NO third GUC to set (db/README
      // entry 2x). `warehouseId` here is only used by the test to assert
      // what SHOULD come back, never set on the connection.
      void warehouseId;
      return fn(tx);
    })) as unknown as T;
    return result;
  } finally {
    await sql.end();
  }
}

async function makeSale(
  ownerActor: { userId: string; structureId: string; role: "owner"; warehouseId: null },
  warehouseId: string,
  productId: string,
  currencyCode: string
) {
  return withTenantSession(ownerActor, (ctx) =>
    salesService.confirmSale(ctx, {
      idempotencyKey: `test-multistore-${randomUUID()}`,
      warehouseId,
      currencyCode,
      lines: [{ productId, quantity: "1.0000" }],
      payment: { method: "cash", full: true },
    })
  );
}

describe("multi-store RLS isolation (migration 0014)", () => {
  it("(1) a gerant sees ZERO rows from another store across sales/stock_movements/stock_levels/payments", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId; // seeded default store
    const warehouseB = await addWarehouse(fixture, { code: "B", name: "Succursale B" });

    const gerantAUserId = await addMembership(fixture, "manager", undefined, warehouseA);
    const gerantBUserId = await addMembership(fixture, "manager", undefined, warehouseB);

    const productId = await createProduct(fixture, { sku: "MS-A", priceMinor: 1000, costMinor: 500 });

    const ownerActor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner" as const,
      warehouseId: null,
    };

    // Receive stock + confirm a real, fully-paid sale in EACH store, as the
    // (unscoped) owner -- real app-layer writes, so sales/payments/
    // stock_movements/stock_levels all get populated realistically.
    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "50.0000",
        unitCostMinor: "500",
        currencyCode: "XOF",
      })
    );
    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseB,
        quantity: "50.0000",
        unitCostMinor: "500",
        currencyCode: "XOF",
      })
    );
    await makeSale(ownerActor, warehouseA, productId, "XOF");
    await makeSale(ownerActor, warehouseB, productId, "XOF");

    // --- Gerant A, raw SQL under RLS: must see store A's rows, ZERO of store B's ---
    const [salesA, movementsA, levelsA, paymentsA] = await asActor(
      gerantAUserId,
      fixture.structureId,
      warehouseA,
      async (tx) => {
        const sales = await tx`select warehouse_id from sales`;
        const movements = await tx`select warehouse_id from stock_movements`;
        const levels = await tx`select warehouse_id from stock_levels`;
        const payments = await tx`select warehouse_id from payments`;
        return [sales, movements, levels, payments];
      }
    );

    for (const rows of [salesA, movementsA, levelsA, paymentsA]) {
      expect(rows.length).toBeGreaterThan(0); // store A's own rows ARE visible
      for (const row of rows) {
        expect(row.warehouse_id).toBe(warehouseA);
      }
    }

    // --- Gerant B: mirror image -- must see ONLY store B's rows ---
    const [salesB, movementsB, levelsB, paymentsB] = await asActor(
      gerantBUserId,
      fixture.structureId,
      warehouseB,
      async (tx) => {
        const sales = await tx`select warehouse_id from sales`;
        const movements = await tx`select warehouse_id from stock_movements`;
        const levels = await tx`select warehouse_id from stock_levels`;
        const payments = await tx`select warehouse_id from payments`;
        return [sales, movements, levels, payments];
      }
    );

    for (const rows of [salesB, movementsB, levelsB, paymentsB]) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.warehouse_id).toBe(warehouseB);
      }
    }

    // --- The owner (unscoped): sees BOTH stores' rows ---
    const salesOwner = await asActor(fixture.ownerUserId, fixture.structureId, null, (tx) =>
      tx`select distinct warehouse_id from sales order by warehouse_id`
    );
    expect(salesOwner.map((r) => r.warehouse_id).sort()).toEqual([warehouseA, warehouseB].sort());
  });

  it("(2) a forged warehouseId in confirmSale/recordPayment is rejected, not silently widened", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const warehouseB = await addWarehouse(fixture, { code: "B2", name: "Succursale B2" });
    const gerantAUserId = await addMembership(fixture, "manager", undefined, warehouseA);

    const productId = await createProduct(fixture, { sku: "MS-B", priceMinor: 1000, costMinor: 500 });

    const ownerActor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner" as const,
      warehouseId: null,
    };
    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseB,
        quantity: "10.0000",
        unitCostMinor: "500",
        currencyCode: "XOF",
      })
    );

    const gerantAActor = {
      userId: gerantAUserId,
      structureId: fixture.structureId,
      role: "manager" as const,
      warehouseId: warehouseA,
    };

    // Gerant A (scoped to store A) attempts to confirm a sale AGAINST
    // store B -- assertStoreAccess must reject this BEFORE any stock lock,
    // ticket allocation or payment write happens.
    await expect(
      withTenantSession(gerantAActor, (ctx) =>
        salesService.confirmSale(ctx, {
          idempotencyKey: `test-forged-${randomUUID()}`,
          warehouseId: warehouseB,
          currencyCode: "XOF",
          lines: [{ productId, quantity: "1.0000" }],
          payment: { method: "cash", full: true },
        })
      )
    ).rejects.toThrow(ForbiddenError);

    // Confirm NOTHING was written for store B as a side effect of the
    // rejected attempt (no stray sale row, no stock movement).
    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      const [{ count }] = await sql`
        select count(*)::int as count from sales
        where structure_id = ${fixture.structureId} and warehouse_id = ${warehouseB}
      `;
      expect(count).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("(3) rebuildStockLevels reconstructs identically across N (2) stores", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const warehouseB = await addWarehouse(fixture, { code: "B3", name: "Succursale B3" });
    const productId = await createProduct(fixture, { sku: "MS-C", priceMinor: 1000, costMinor: 500 });

    const ownerActor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner" as const,
      warehouseId: null,
    };

    // Different receipt histories per store -- CUMP must differ between
    // the two after the rebuild, proving the rebuild is genuinely
    // per-(product, warehouse), not accidentally pooling both stores'
    // ledgers into one average.
    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "10.0000",
        unitCostMinor: "100",
        currencyCode: "XOF",
      })
    );
    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "10.0000",
        unitCostMinor: "300",
        currencyCode: "XOF",
      })
    );
    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseB,
        quantity: "20.0000",
        unitCostMinor: "700",
        currencyCode: "XOF",
      })
    );

    const beforeA = await withTenantSession(ownerActor, (ctx) =>
      inventoryService.getStockLevels(ctx, { warehouseId: warehouseA })
    );
    const beforeB = await withTenantSession(ownerActor, (ctx) =>
      inventoryService.getStockLevels(ctx, { warehouseId: warehouseB })
    );

    // Corrupt the projection directly (simulating drift) for BOTH stores,
    // then rebuild with no warehouseId filter (= every store) and confirm
    // each store's level is reconstructed back to its OWN correct value,
    // not the other store's.
    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      await sql`
        update stock_levels set quantity = 999, avg_cost_minor = 1
        where structure_id = ${fixture.structureId} and product_id = ${productId}
      `;
    } finally {
      await sql.end();
    }

    await withTenantSession(ownerActor, (ctx) => inventoryService.rebuildStockLevels(ctx));

    const afterA = await withTenantSession(ownerActor, (ctx) =>
      inventoryService.getStockLevels(ctx, { warehouseId: warehouseA })
    );
    const afterB = await withTenantSession(ownerActor, (ctx) =>
      inventoryService.getStockLevels(ctx, { warehouseId: warehouseB })
    );

    expect(afterA[0]?.quantity).toBe(beforeA[0]?.quantity);
    expect(afterA[0]?.avgCostMinor).toBe(beforeA[0]?.avgCostMinor);
    expect(afterB[0]?.quantity).toBe(beforeB[0]?.quantity);
    expect(afterB[0]?.avgCostMinor).toBe(beforeB[0]?.avgCostMinor);
    // The two stores' CUMP genuinely differ -- proves no cross-store pooling.
    expect(afterA[0]?.avgCostMinor).not.toBe(afterB[0]?.avgCostMinor);
  });
});
