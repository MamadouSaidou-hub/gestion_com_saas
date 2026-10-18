import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, beforeAll } from "vitest";
import { APP_URL, MIGRATOR_URL } from "./db-constants";
import { seedStructure, addWarehouse, addMembership, createProduct } from "./seed";

// ---------------------------------------------------------------------------
// Inter-store transfers + physical stock counts integration suite (this
// phase). Proves, against a disposable container, exactly the properties
// the coordinator asked for execution-based proof of:
//
//  (1) value is conserved across an A->B->A round trip (the CUMP snapshot
//      rule -- never the destination's current average, never recomputed).
//  (2) a double-receive is impossible CONCURRENTLY, not just sequentially
//      (the UPDATE-as-arbiter guard).
//  (3) an in-transit transfer is in NEITHER store's stock_levels, but IS
//      counted in the derived in-transit figure.
//  (4) a gérant cannot create a transfer from someone else's store, nor
//      receive into one that isn't theirs.
//  (5) a validated count with a negative variance moves the ledger and the
//      projection consistently, and the projection is NEVER written to
//      directly (no code path updates stock_levels outside a movement
//      insert -- verified here by reconciling the final quantity against
//      the ledger sum, not merely trusting the projection).
//  (6) a replayed idempotency key creates ONE transfer, not two.
// ---------------------------------------------------------------------------

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let inventoryService: typeof import("@/modules/inventory").inventoryService;
let stockTransfersService: typeof import("@/modules/stock-transfers").stockTransfersService;
let TransferNotFoundError: typeof import("@/modules/stock-transfers").TransferNotFoundError;
let ForbiddenError: typeof import("@/platform/errors").ForbiddenError;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
  process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ inventoryService } = await import("@/modules/inventory"));
  ({ stockTransfersService, TransferNotFoundError } = await import("@/modules/stock-transfers"));
  ({ ForbiddenError } = await import("@/platform/errors"));
});

function ownerActorOf(fixture: { ownerUserId: string; structureId: string }) {
  return { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" as const, warehouseId: null };
}

async function rawStockLevel(structureId: string, productId: string, warehouseId: string) {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const [row] = await sql`
      select quantity, avg_cost_minor from stock_levels
      where structure_id = ${structureId} and product_id = ${productId} and warehouse_id = ${warehouseId}
    `;
    return row ? { quantity: row.quantity as string, avgCostMinor: BigInt(row.avg_cost_minor) } : null;
  } finally {
    await sql.end();
  }
}

async function rawTransferCount(structureId: string, idempotencyKey: string) {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const [{ count }] = await sql`
      select count(*)::int as count from stock_transfers
      where structure_id = ${structureId} and idempotency_key = ${idempotencyKey}
    `;
    return count as number;
  } finally {
    await sql.end();
  }
}

async function rawMovementSum(structureId: string, productId: string, warehouseId: string) {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const rows = await sql`
      select direction, quantity from stock_movements
      where structure_id = ${structureId} and product_id = ${productId} and warehouse_id = ${warehouseId}
    `;
    let total = 0;
    for (const row of rows) {
      const qty = Number(row.quantity);
      total += row.direction === "in" ? qty : -qty;
    }
    return total;
  } finally {
    await sql.end();
  }
}

describe("stock transfers + physical counts (this phase)", () => {
  it("(1) value is conserved across an A->B->A round trip -- CUMP snapshot, never recomputed", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const warehouseB = await addWarehouse(fixture, { code: "TB1", name: "Succursale TB1" });
    const productId = await createProduct(fixture, { sku: "XFER-1", priceMinor: 1000, costMinor: 400 });
    const ownerActor = ownerActorOf(fixture);

    // Stock A at avg cost 400.
    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "10.0000",
        unitCostMinor: "400",
        currencyCode: "XOF",
      })
    );

    const beforeA = await rawStockLevel(fixture.structureId, productId, warehouseA);
    const totalValueBefore = Number(beforeA!.quantity) * Number(beforeA!.avgCostMinor);

    // A -> B: 10 units leave A at cost 400.
    const transferOut = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.createTransfer(ctx, {
        idempotencyKey: `test-roundtrip-out-${randomUUID()}`,
        fromWarehouseId: warehouseA,
        toWarehouseId: warehouseB,
        lines: [{ productId, quantity: "10.0000" }],
      })
    );

    // While in transit: NEITHER store's stock_levels holds these units.
    const inTransitA = await rawStockLevel(fixture.structureId, productId, warehouseA);
    const inTransitB = await rawStockLevel(fixture.structureId, productId, warehouseB);
    expect(inTransitA?.quantity ?? "0.0000").toBe("0.0000");
    expect(inTransitB).toBeNull();

    // But the derived in-transit figure counts it.
    const inTransitTotals = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.getInTransitByProduct(ctx, null)
    );
    expect(inTransitTotals[productId]).toBe("10.0000");

    // B receives at the SAME cost (400) -- not B's current average (B had none).
    await withTenantSession(ownerActor, (ctx) => stockTransfersService.receiveTransfer(ctx, transferOut.id));
    const afterReceiveB = await rawStockLevel(fixture.structureId, productId, warehouseB);
    expect(afterReceiveB?.quantity).toBe("10.0000");
    expect(afterReceiveB?.avgCostMinor).toBe(400n);

    // B -> A: send the SAME 10 units back. The transfer-out leg snapshots
    // B's CURRENT average (400, unchanged by the receipt since B had no
    // prior stock to blend with) -- not a recomputed value.
    const transferBack = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.createTransfer(ctx, {
        idempotencyKey: `test-roundtrip-back-${randomUUID()}`,
        fromWarehouseId: warehouseB,
        toWarehouseId: warehouseA,
        lines: [{ productId, quantity: "10.0000" }],
      })
    );
    await withTenantSession(ownerActor, (ctx) => stockTransfersService.receiveTransfer(ctx, transferBack.id));

    const afterA = await rawStockLevel(fixture.structureId, productId, warehouseA);
    const totalValueAfter = Number(afterA!.quantity) * Number(afterA!.avgCostMinor);

    // Quantity AND total value are both restored exactly -- no value
    // created or destroyed by the round trip.
    expect(afterA?.quantity).toBe(beforeA?.quantity);
    expect(afterA?.avgCostMinor).toBe(beforeA?.avgCostMinor);
    expect(totalValueAfter).toBe(totalValueBefore);
  });

  it("(2) a double-receive is impossible CONCURRENTLY", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const warehouseB = await addWarehouse(fixture, { code: "TB2", name: "Succursale TB2" });
    const productId = await createProduct(fixture, { sku: "XFER-2", priceMinor: 1000, costMinor: 400 });
    const ownerActor = ownerActorOf(fixture);

    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "20.0000",
        unitCostMinor: "400",
        currencyCode: "XOF",
      })
    );

    const transfer = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.createTransfer(ctx, {
        idempotencyKey: `test-double-receive-${randomUUID()}`,
        fromWarehouseId: warehouseA,
        toWarehouseId: warehouseB,
        lines: [{ productId, quantity: "20.0000" }],
      })
    );

    // Fire 5 concurrent receive attempts for the SAME transfer.
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        withTenantSession(ownerActor, (ctx) => stockTransfersService.receiveTransfer(ctx, transfer.id))
      )
    );

    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);

    // Exactly ONE "in" movement was posted at the destination, not five.
    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      const [{ count }] = await sql`
        select count(*)::int as count from stock_movements
        where structure_id = ${fixture.structureId} and transfer_id = ${transfer.id} and direction = 'in'
      `;
      expect(count).toBe(1);
    } finally {
      await sql.end();
    }

    const finalB = await rawStockLevel(fixture.structureId, productId, warehouseB);
    expect(finalB?.quantity).toBe("20.0000"); // not 100 (5x20)
  });

  it("(3) an in-transit transfer is in NEITHER store's stock_levels, but IS counted in the derived figure", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const warehouseB = await addWarehouse(fixture, { code: "TB3", name: "Succursale TB3" });
    const productId = await createProduct(fixture, { sku: "XFER-3", priceMinor: 1000, costMinor: 400 });
    const ownerActor = ownerActorOf(fixture);

    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "15.0000",
        unitCostMinor: "400",
        currencyCode: "XOF",
      })
    );

    await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.createTransfer(ctx, {
        idempotencyKey: `test-invariant-${randomUUID()}`,
        fromWarehouseId: warehouseA,
        toWarehouseId: warehouseB,
        lines: [{ productId, quantity: "6.0000" }],
      })
    );

    const levelA = await rawStockLevel(fixture.structureId, productId, warehouseA);
    const levelB = await rawStockLevel(fixture.structureId, productId, warehouseB);
    const inTransit = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.getInTransitByProduct(ctx, null)
    );

    // Invariant: Σ stock_levels.quantity + in_transit = quantity held (15).
    const heldInLevels = Number(levelA?.quantity ?? "0") + Number(levelB?.quantity ?? "0");
    const inTransitQty = Number(inTransit[productId] ?? "0");
    expect(heldInLevels + inTransitQty).toBe(15);
    expect(levelA?.quantity).toBe("9.0000");
    expect(levelB).toBeNull(); // no phantom row at the destination either
  });

  it("(4) a gérant cannot create a transfer from someone else's store, nor receive into one that isn't theirs", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const warehouseB = await addWarehouse(fixture, { code: "TB4", name: "Succursale TB4" });
    const warehouseC = await addWarehouse(fixture, { code: "TB4c", name: "Succursale TB4c" });
    const gerantAUserId = await addMembership(fixture, "manager", undefined, warehouseA);
    const gerantCUserId = await addMembership(fixture, "manager", undefined, warehouseC);
    const productId = await createProduct(fixture, { sku: "XFER-4", priceMinor: 1000, costMinor: 400 });
    const ownerActor = ownerActorOf(fixture);

    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseB,
        quantity: "10.0000",
        unitCostMinor: "400",
        currencyCode: "XOF",
      })
    );

    const gerantAActor = { userId: gerantAUserId, structureId: fixture.structureId, role: "manager" as const, warehouseId: warehouseA };

    // Gérant A attempts to create a transfer FROM store B (not theirs).
    await expect(
      withTenantSession(gerantAActor, (ctx) =>
        stockTransfersService.createTransfer(ctx, {
          idempotencyKey: `test-forged-create-${randomUUID()}`,
          fromWarehouseId: warehouseB,
          toWarehouseId: warehouseA,
          lines: [{ productId, quantity: "1.0000" }],
        })
      )
    ).rejects.toThrow(ForbiddenError);

    // A legitimate transfer B -> C, created by the owner.
    const transfer = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.createTransfer(ctx, {
        idempotencyKey: `test-forged-receive-${randomUUID()}`,
        fromWarehouseId: warehouseB,
        toWarehouseId: warehouseC,
        lines: [{ productId, quantity: "5.0000" }],
      })
    );

    // Gérant A (store A, neither leg of this transfer) attempts to receive
    // it. The RLS FLOOR (migration 0014's store-scope predicate) hides the
    // row entirely for a store-scoped actor who is neither leg -- the
    // request never even reaches the app-layer CEILING check, it 404s at
    // the repository read, same convention as a non-member's structureId
    // (resolveActor's NotAMemberError) producing a "not found" rather than
    // a "forbidden" elsewhere in this codebase.
    await expect(
      withTenantSession(gerantAActor, (ctx) => stockTransfersService.receiveTransfer(ctx, transfer.id))
    ).rejects.toThrow(TransferNotFoundError);

    // Gérant C (the REAL destination) can receive it.
    const gerantCActor = { userId: gerantCUserId, structureId: fixture.structureId, role: "manager" as const, warehouseId: warehouseC };
    const received = await withTenantSession(gerantCActor, (ctx) =>
      stockTransfersService.receiveTransfer(ctx, transfer.id)
    );
    expect(received.status).toBe("received");
  });

  it("(5) a validated count with a negative variance moves the ledger and the projection consistently, never writing stock_levels directly", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const productId = await createProduct(fixture, { sku: "COUNT-1", priceMinor: 1000, costMinor: 250 });
    const ownerActor = ownerActorOf(fixture);

    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "50.0000",
        unitCostMinor: "250",
        currencyCode: "XOF",
      })
    );

    const opened = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.openStockCount(ctx, {
        idempotencyKey: `test-count-${randomUUID()}`,
        warehouseId: warehouseA,
        productIds: [productId],
      })
    );
    expect(opened.lines[0]?.theoreticalQty).toBe("50.0000");

    // Physical count finds only 42 -- a loss of 8 units.
    const validated = await withTenantSession(ownerActor, (ctx) =>
      stockTransfersService.validateStockCount(ctx, {
        stockCountId: opened.id,
        lines: [{ productId, countedQty: "42.0000" }],
      })
    );
    expect(validated.lines[0]?.varianceQty).toBe("-8.0000");
    expect(validated.lines[0]?.unitCostMinor).toBe("250"); // current CUMP, unchanged by the count

    const level = await rawStockLevel(fixture.structureId, productId, warehouseA);
    expect(level?.quantity).toBe("42.0000");
    expect(level?.avgCostMinor).toBe(250n); // a count never changes the average cost

    // Reconcile the projection against the ledger alone (never trust
    // stock_levels on its own) -- 50 (receipt) - 8 (count adjustment out) = 42.
    const ledgerNet = await rawMovementSum(fixture.structureId, productId, warehouseA);
    expect(ledgerNet).toBe(42);

    // Exactly one `count_adjustment` movement was posted, tagged with
    // stock_count_id (not the legacy polymorphic pair).
    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      const rows = await sql`
        select direction, quantity, stock_count_id, source_type from stock_movements
        where structure_id = ${fixture.structureId} and reason = 'count_adjustment'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.direction).toBe("out");
      expect(rows[0]!.quantity).toBe("8.0000");
      expect(rows[0]!.stock_count_id).toBe(opened.id);
      expect(rows[0]!.source_type).toBeNull();
    } finally {
      await sql.end();
    }
  });

  it("(6) a replayed idempotency key creates ONE transfer, not two", async () => {
    const fixture = await seedStructure();
    const warehouseA = fixture.warehouseId;
    const warehouseB = await addWarehouse(fixture, { code: "TB6", name: "Succursale TB6" });
    const productId = await createProduct(fixture, { sku: "XFER-6", priceMinor: 1000, costMinor: 400 });
    const ownerActor = ownerActorOf(fixture);

    await withTenantSession(ownerActor, (ctx) =>
      inventoryService.receiveStock(ctx, {
        productId,
        warehouseId: warehouseA,
        quantity: "30.0000",
        unitCostMinor: "400",
        currencyCode: "XOF",
      })
    );

    const idempotencyKey = `test-replay-${randomUUID()}`;
    const input = {
      idempotencyKey,
      fromWarehouseId: warehouseA,
      toWarehouseId: warehouseB,
      lines: [{ productId, quantity: "4.0000" }],
    };

    const first = await withTenantSession(ownerActor, (ctx) => stockTransfersService.createTransfer(ctx, input));
    expect(first.replayed).toBe(false);

    const second = await withTenantSession(ownerActor, (ctx) => stockTransfersService.createTransfer(ctx, input));
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    const count = await rawTransferCount(fixture.structureId, idempotencyKey);
    expect(count).toBe(1);

    // Stock was only decremented ONCE (4 units, not 8).
    const level = await rawStockLevel(fixture.structureId, productId, warehouseA);
    expect(level?.quantity).toBe("26.0000");
  });
});
