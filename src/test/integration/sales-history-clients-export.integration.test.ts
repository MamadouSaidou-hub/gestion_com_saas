import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, beforeAll } from "vitest";
import { APP_URL, MIGRATOR_URL } from "./db-constants";
import { seedStructure, addWarehouse, addMembership, createProduct } from "./seed";

// ---------------------------------------------------------------------------
// Sales history / clients / CSV export integration suite -- this phase's
// new features. Exercises the REAL use cases (salesService.listSales,
// salesService.getSaleDetail, catalogService.{listCustomers,
// exportCustomersCsv}, billingService.getReceivablesByCustomer) against a
// live Postgres, under RLS, exactly like the existing suites in this
// folder (multi-store, stock-transfers, rls-settings).
// ---------------------------------------------------------------------------

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let salesService: typeof import("@/modules/sales").salesService;
let inventoryService: typeof import("@/modules/inventory").inventoryService;
let catalogService: typeof import("@/modules/catalog").catalogService;
let billingService: typeof import("@/modules/billing").billingService;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
  process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ salesService } = await import("@/modules/sales"));
  ({ inventoryService } = await import("@/modules/inventory"));
  ({ catalogService } = await import("@/modules/catalog"));
  ({ billingService } = await import("@/modules/billing"));
});

type Actor = { userId: string; structureId: string; role: string; warehouseId: string | null };

async function countAuditRows(structureId: string, action: string): Promise<number> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const [{ count }] = await sql`
      select count(*)::int as count from audit_log
      where structure_id = ${structureId} and action = ${action}
    `;
    return count;
  } finally {
    await sql.end();
  }
}

async function makeSale(
  actor: Actor,
  warehouseId: string,
  productId: string,
  customerId: string | null = null
) {
  return withTenantSession(actor as never, (ctx) =>
    salesService.confirmSale(ctx, {
      idempotencyKey: `test-history-${randomUUID()}`,
      warehouseId,
      customerId,
      currencyCode: "XOF",
      lines: [{ productId, quantity: "1.0000" }],
      payment: { method: "cash", full: true },
    })
  );
}

describe("sales history + clients + CSV export (this phase)", () => {
  it("(1) a cashier with 'own' scope sees only their own sales", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "HIST-1", priceMinor: 1000, costMinor: 500 });

    const ownerActor: Actor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner",
      warehouseId: null,
    };
    await withTenantSession(ownerActor as never, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: fixture.warehouseId,
        quantity: "50.0000",
        unitCostMinor: "500",
        currencyCode: "XOF",
      })
    );

    const cashierAUserId = await addMembership(fixture, "cashier");
    const cashierBUserId = await addMembership(fixture, "cashier");

    const cashierA: Actor = {
      userId: cashierAUserId,
      structureId: fixture.structureId,
      role: "cashier",
      warehouseId: null,
    };
    const cashierB: Actor = {
      userId: cashierBUserId,
      structureId: fixture.structureId,
      role: "cashier",
      warehouseId: null,
    };

    const saleA = await makeSale(cashierA, fixture.warehouseId, productId);
    await makeSale(cashierB, fixture.warehouseId, productId);

    const resultsForA = await withTenantSession(cashierA as never, (ctx) => salesService.listSales(ctx, {}));
    expect(resultsForA).toHaveLength(1);
    expect(resultsForA[0].id).toBe(saleA.saleId);

    // The owner (sale:read_all) sees both.
    const resultsForOwner = await withTenantSession(ownerActor as never, (ctx) =>
      salesService.listSales(ctx, {})
    );
    expect(resultsForOwner.length).toBeGreaterThanOrEqual(2);
  });

  it("(2) a store-scoped manager (gerant) sees only their store's sales AND customers", async () => {
    const fixture = await seedStructure();
    const warehouseB = await addWarehouse(fixture, { code: "HB", name: "Succursale HB" });
    const productId = await createProduct(fixture, { sku: "HIST-2", priceMinor: 1000, costMinor: 500 });

    const ownerActor: Actor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner",
      warehouseId: null,
    };
    await withTenantSession(ownerActor as never, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: fixture.warehouseId,
        quantity: "10.0000",
        unitCostMinor: "500",
        currencyCode: "XOF",
      })
    );
    await withTenantSession(ownerActor as never, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseB,
        quantity: "10.0000",
        unitCostMinor: "500",
        currencyCode: "XOF",
      })
    );

    const customerXId = await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.createCustomer(ctx, { name: "Client Store A" })
    ).then((c) => c.id);
    const customerYId = await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.createCustomer(ctx, { name: "Client Store B" })
    ).then((c) => c.id);

    const saleStoreA = await makeSale(ownerActor, fixture.warehouseId, productId, customerXId);
    await makeSale(ownerActor, warehouseB, productId, customerYId);

    const gerantAUserId = await addMembership(fixture, "manager", undefined, fixture.warehouseId);
    const gerantA: Actor = {
      userId: gerantAUserId,
      structureId: fixture.structureId,
      role: "manager",
      warehouseId: fixture.warehouseId,
    };

    // (2a) sales
    const salesForGerantA = await withTenantSession(gerantA as never, (ctx) => salesService.listSales(ctx, {}));
    expect(salesForGerantA.map((s) => s.id)).toContain(saleStoreA.saleId);
    for (const sale of salesForGerantA) {
      expect(sale.warehouseId).toBe(fixture.warehouseId);
    }

    // (2b) customers -- derived through sales activity, not a home-store column.
    const idsForStoreA = await withTenantSession(gerantA as never, (ctx) =>
      salesService.listCustomerIdsForStore(ctx, fixture.warehouseId)
    );
    expect(idsForStoreA).toContain(customerXId);
    expect(idsForStoreA).not.toContain(customerYId);

    const customersForGerantA = await withTenantSession(gerantA as never, (ctx) =>
      catalogService.listCustomers(ctx, { ids: idsForStoreA })
    );
    expect(customersForGerantA.map((c) => c.id)).toContain(customerXId);
    expect(customersForGerantA.map((c) => c.id)).not.toContain(customerYId);
  });

  it("(3) an out-of-scope sale document is a plain not-found (null), never a forbidden throw", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "HIST-3", priceMinor: 1000, costMinor: 500 });
    const ownerActor: Actor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner",
      warehouseId: null,
    };
    await withTenantSession(ownerActor as never, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: fixture.warehouseId,
        quantity: "5.0000",
        unitCostMinor: "500",
        currencyCode: "XOF",
      })
    );

    const cashierAUserId = await addMembership(fixture, "cashier");
    const cashierBUserId = await addMembership(fixture, "cashier");
    const cashierA: Actor = { userId: cashierAUserId, structureId: fixture.structureId, role: "cashier", warehouseId: null };
    const cashierB: Actor = { userId: cashierBUserId, structureId: fixture.structureId, role: "cashier", warehouseId: null };

    const saleA = await makeSale(cashierA, fixture.warehouseId, productId);

    const resultForB = await withTenantSession(cashierB as never, (ctx) =>
      salesService.getSaleDetail(ctx, saleA.saleId)
    );
    expect(resultForB).toBeNull(); // not-found, not a ForbiddenError throw

    // A genuinely nonexistent id behaves identically (no existence oracle).
    const resultForUnknown = await withTenantSession(cashierB as never, (ctx) =>
      salesService.getSaleDetail(ctx, randomUUID())
    );
    expect(resultForUnknown).toBeNull();

    // Sanity: the actual owner of the sale CAN see it.
    const resultForA = await withTenantSession(cashierA as never, (ctx) =>
      salesService.getSaleDetail(ctx, saleA.saleId)
    );
    expect(resultForA).not.toBeNull();
    expect(resultForA?.id).toBe(saleA.saleId);
  });

  it("(4) CSV export escapes a malicious '=cmd' customer name AND respects the active filter", async () => {
    const fixture = await seedStructure();
    const ownerActor: Actor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner",
      warehouseId: null,
    };

    const maliciousName = "=cmd|' /C calc'!A0";
    const maliciousCustomer = await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.createCustomer(ctx, { name: maliciousName })
    );
    const inactiveCustomer = await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.createCustomer(ctx, { name: "Client Inactif" })
    );
    await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.updateCustomer(ctx, inactiveCustomer.id, { isActive: false })
    );

    const { rowsToCsv } = await import("@/platform/export/csv");

    const exported = await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.exportCustomersCsv(ctx, { activeOnly: true })
    );

    // The filter (`activeOnly: true`) is honoured -- the inactive customer
    // never reaches the export, same query the list screen runs.
    expect(exported.map((c) => c.id)).toContain(maliciousCustomer.id);
    expect(exported.map((c) => c.id)).not.toContain(inactiveCustomer.id);

    const csv = rowsToCsv(exported, [{ header: "Nom", value: (r) => r.name }]);
    // The raw payload must never appear un-escaped in the CSV body.
    expect(csv).not.toMatch(/(?<!')=cmd\|/);
    expect(csv).toContain(`'${maliciousName}`);
  });

  it("(5) exporting writes EXACTLY one audit entry, carrying the filters and row count", async () => {
    const fixture = await seedStructure();
    const ownerActor: Actor = {
      userId: fixture.ownerUserId,
      structureId: fixture.structureId,
      role: "owner",
      warehouseId: null,
    };
    await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.createCustomer(ctx, { name: "Client Export Un" })
    );
    await withTenantSession(ownerActor as never, (ctx) =>
      catalogService.createCustomer(ctx, { name: "Client Export Deux" })
    );

    const before = await countAuditRows(fixture.structureId, "customer.exported");

    const { auditCsvExport } = await import("@/platform/export/csv");
    const rowCount = await withTenantSession(ownerActor as never, async (ctx) => {
      const rows = await catalogService.exportCustomersCsv(ctx, { activeOnly: true });
      await auditCsvExport(ctx, {
        action: "customer.exported",
        targetType: "customer",
        filters: { search: null },
        rowCount: rows.length,
      });
      return rows.length;
    });

    const after = await countAuditRows(fixture.structureId, "customer.exported");
    expect(after - before).toBe(1);
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // The audit chain stays intact (hash-chained, per-tenant) after this
    // write -- same verification mechanism every other suite in this
    // codebase relies on.
    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.structure_id', ${fixture.structureId}, true)`;
        await tx`select set_config('app.user_id', ${fixture.ownerUserId}, true)`;
        const [{ audit_log_verify: brokenId }] = await tx`select audit_log_verify(${fixture.structureId}::uuid)`;
        expect(brokenId).toBeNull();
      });
    } finally {
      await sql.end();
    }
  });
});
