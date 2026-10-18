import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { MIGRATOR_URL } from "./db-constants";

// ---------------------------------------------------------------------------
// Test fixture seeding -- connects as the MIGRATOR role (BYPASSRLS) to set
// up tenant data directly, the same way a one-off operator script would,
// NOT through the app layer. This deliberately does NOT exercise
// catalog/inventory's own use cases for setup (those already have their
// own unit tests from Phase 1 step 2) -- this suite's job is to validate
// confirmSale's orchestration, not re-validate receiveStock/createProduct.
// ---------------------------------------------------------------------------

export interface StructureFixture {
  structureId: string;
  ownerUserId: string;
  warehouseId: string;
  unitId: string;
  customerId: string;
}

export async function seedStructure(): Promise<StructureFixture> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const ownerUserId = `test-owner-${randomUUID()}`;
    // create_structure_with_owner() checks app_current_user_id() against
    // the session GUC -- set it for this throwaway connection before
    // calling it (migrator is BYPASSRLS, so this is only for the
    // function's own explicit `raise exception` check, not RLS).
    await sql`select set_config('app.user_id', ${ownerUserId}, false)`;
    const [{ id: structureId }] = await sql`
      select create_structure_with_owner(
        'Test Boutique', 'SN', 'XOF', ${ownerUserId}, 'cump'
      ) as id
    `;

    const [{ id: warehouseId }] = await sql`
      insert into warehouses (structure_id, name, is_default)
      values (${structureId}, 'Entrepot principal', true)
      returning id
    `;
    const [{ id: unitId }] = await sql`
      insert into units (structure_id, code, name)
      values (${structureId}, 'pcs', 'Piece')
      returning id
    `;
    const [{ id: customerId }] = await sql`
      insert into customers (structure_id, name)
      values (${structureId}, 'Client Test')
      returning id
    `;

    return { structureId, ownerUserId, warehouseId, unitId, customerId };
  } finally {
    await sql.end();
  }
}

// RLS's floor (`tenant_access`/`has_role_in_current_structure`) checks a
// REAL `memberships` row, not just the GUC values a hand-constructed test
// Actor carries -- any test that reaches a real table query (not just an
// in-memory `assertCan` check) with a role other than the fixture's owner
// MUST call this first, or every RLS-gated query will reject/empty-return
// regardless of the application-layer permission check being correct.
export async function addMembership(
  fixture: StructureFixture,
  role: string,
  userId?: string
): Promise<string> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const actualUserId = userId ?? `test-${role}-${randomUUID()}`;
    await sql`
      insert into memberships (user_id, structure_id, role, status)
      values (${actualUserId}, ${fixture.structureId}, ${role}, 'active')
    `;
    return actualUserId;
  } finally {
    await sql.end();
  }
}

export interface CreateProductOptions {
  sku: string;
  priceMinor: number;
  costMinor?: number;
  lowStockThreshold?: string | null;
  isActive?: boolean;
  currencyCode?: string;
}

export async function createProduct(
  fixture: StructureFixture,
  options: CreateProductOptions
): Promise<string> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const [{ id }] = await sql`
      insert into products (
        structure_id, unit_id, sku, name, currency_code,
        default_price_minor, default_cost_minor, low_stock_threshold, is_active
      )
      values (
        ${fixture.structureId}, ${fixture.unitId}, ${options.sku}, ${options.sku}, ${options.currencyCode ?? "XOF"},
        ${options.priceMinor}, ${options.costMinor ?? 0}, ${options.lowStockThreshold ?? null},
        ${options.isActive ?? true}
      )
      returning id
    `;
    return id;
  } finally {
    await sql.end();
  }
}

// Sets stock_levels directly to a known quantity/avg cost -- simpler and
// more deterministic for test assertions than going through receiveStock's
// CUMP projection (already covered by its own unit tests).
export async function setStockLevel(
  fixture: StructureFixture,
  productId: string,
  quantity: string,
  avgCostMinor: number,
  currencyCode = "XOF"
): Promise<void> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    await sql`
      insert into stock_levels (structure_id, product_id, warehouse_id, quantity, avg_cost_minor, currency_code)
      values (${fixture.structureId}, ${productId}, ${fixture.warehouseId}, ${quantity}, ${avgCostMinor}, ${currencyCode})
      on conflict (structure_id, product_id, warehouse_id)
      do update set quantity = excluded.quantity, avg_cost_minor = excluded.avg_cost_minor
    `;
  } finally {
    await sql.end();
  }
}

export interface RawCounts {
  salesCount: number;
  movementsCount: number;
  auditCount: number;
  stockQuantity: string | null;
}

// Direct, migrator-role reads used ONLY for test assertions (never for
// confirmSale's own logic) -- lets atomicity tests verify "zero rows"
// independent of the app layer's own repositories.
export async function readCounts(fixture: StructureFixture, productId: string): Promise<RawCounts> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const [{ count: salesCount }] = await sql`
      select count(*)::int as count from sales where structure_id = ${fixture.structureId}
    `;
    const [{ count: movementsCount }] = await sql`
      select count(*)::int as count from stock_movements where structure_id = ${fixture.structureId}
    `;
    const [{ count: auditCount }] = await sql`
      select count(*)::int as count from audit_log where structure_id = ${fixture.structureId}
    `;
    const [level] = await sql`
      select quantity from stock_levels
      where structure_id = ${fixture.structureId} and product_id = ${productId} and warehouse_id = ${fixture.warehouseId}
    `;
    return {
      salesCount,
      movementsCount,
      auditCount,
      stockQuantity: level?.quantity ?? null,
    };
  } finally {
    await sql.end();
  }
}

export async function readDocumentCounter(
  fixture: StructureFixture,
  fiscalYear: number
): Promise<bigint | null> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const [row] = await sql`
      select next_value from document_counters
      where structure_id = ${fixture.structureId} and doc_type = 'ticket' and fiscal_year = ${fiscalYear}
    `;
    return row ? BigInt(row.next_value) : null;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Direct DB manipulation for analytics test scenarios that can't be
// produced through the public use cases yet (no `voidSale` use case this
// phase; `confirmSale` always uses the real server clock for
// `confirmed_at`). Migrator-role, bypasses RLS -- test setup only, never
// something application code does.
// ---------------------------------------------------------------------------

export async function backdateSaleConfirmedAt(
  fixture: StructureFixture,
  saleId: string,
  confirmedAt: Date
): Promise<void> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    await sql`
      update sales set confirmed_at = ${confirmedAt}
      where structure_id = ${fixture.structureId} and id = ${saleId}
    `;
  } finally {
    await sql.end();
  }
}

// Simulates what a future `voidSale` use case would do to the `sales` row
// (status/cancelledAt) -- does NOT reverse stock or payments, since this
// phase only needs the ANALYTICS read side to react correctly to a
// cancelled sale's row state, not the full cancellation business logic.
export async function cancelSaleDirect(fixture: StructureFixture, saleId: string): Promise<void> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    await sql`
      update sales set status = 'cancelled', cancelled_at = now(), cancelled_by = ${fixture.ownerUserId}
      where structure_id = ${fixture.structureId} and id = ${saleId}
    `;
  } finally {
    await sql.end();
  }
}

export async function setVatRate(fixture: StructureFixture, vatRate: string): Promise<void> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    await sql`
      insert into tax_settings (structure_id, vat_rate)
      values (${fixture.structureId}, ${vatRate})
      on conflict (structure_id) do update set vat_rate = excluded.vat_rate
    `;
  } finally {
    await sql.end();
  }
}
