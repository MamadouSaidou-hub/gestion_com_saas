import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  numeric,
  pgEnum,
  primaryKey,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { structures, currencies } from "./tenancy";
import { products, warehouses } from "./catalog";
import { sales } from "./sales";

// ---------------------------------------------------------------------------
// Inventory module (D9):
//  - `stock_movements` is the append-only ledger and SOURCE OF TRUTH.
//  - `stock_levels` is a DERIVED / RECOMPUTABLE projection (current quantity +
//    average cost), not a source of truth. It exists purely as a fast-read
//    cache; it must always be rebuildable from `stock_movements` alone.
// Only the CUMP (weighted-average) projection is implemented. FIFO is a valid
// `structures.valuation_method` value but has no projection logic yet.
// ---------------------------------------------------------------------------

export const stockDirectionEnum = pgEnum("stock_direction", ["in", "out"]);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    direction: stockDirectionEnum("direction").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    reason: text("reason").notNull(), // e.g. 'purchase', 'sale', 'adjustment', 'transfer'
    // Legacy polymorphic reference — KEPT for sources that have no dedicated
    // table yet (e.g. 'manual', 'adjustment'). Retired to its own composite-
    // FK column (like `saleId` below) as each source table appears.
    // Added by 0009: hardened via `stock_movements_source_consistency_chk`
    // (see check() below) so `source_type = 'sale'` can no longer be used —
    // a sale-driven movement MUST go through `saleId` instead.
    sourceType: text("source_type"), // e.g. 'purchase_order', 'manual' ('sale' retired, see saleId)
    sourceId: uuid("source_id"),
    // Added by hand-written migration 0009 (architect option A2): explicit,
    // composite-FK'd reference replacing the polymorphic source_type='sale'
    // case — a sale-driven movement can no longer reference another
    // tenant's sale, enforced by the DB, not just app discipline.
    saleId: uuid("sale_id"),
    // --- Added by migration 0014 (closes debt 2r in full) ---
    // transfer_id / stock_count_id: composite-FK'd to stock_transfers /
    // stock_counts (both new in 0014). supplier_delivery_id: column only --
    // no FK yet, deferred to the migration that ships the
    // supplier_deliveries table (later phase) -- it must still be one of
    // the exclusive-arc slots below today.
    transferId: uuid("transfer_id"),
    stockCountId: uuid("stock_count_id"),
    supplierDeliveryId: uuid("supplier_delivery_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("stock_movements_structure_id_idx").on(t.structureId),
    index("stock_movements_product_idx").on(t.structureId, t.productId),
    index("stock_movements_warehouse_idx").on(t.structureId, t.warehouseId),
    index("stock_movements_occurred_at_idx").on(t.structureId, t.occurredAt),
    index("stock_movements_sale_idx").on(t.structureId, t.saleId),
    foreignKey({
      columns: [t.structureId, t.productId],
      foreignColumns: [products.structureId, products.id],
      name: "stock_movements_product_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.warehouseId],
      foreignColumns: [warehouses.structureId, warehouses.id],
      name: "stock_movements_warehouse_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.saleId],
      foreignColumns: [sales.structureId, sales.id],
      name: "stock_movements_sale_fk",
    }),
    // Replaced by migration 0014's exclusive-arc rewrite (closes debt 2r):
    // exactly ONE of (saleId, transferId, stockCountId, supplierDeliveryId,
    // sourceType) may be set, sourceType narrowed to
    // ('manual', 'adjustment', 'opening'). The composite FKs to
    // stock_transfers/stock_counts are added by the hand-written SQL
    // migration (not expressed as `.references()` thunks here, to avoid
    // importing those tables' module into inventory.ts -- same import-cycle
    // avoidance reasoning as catalog.ts/tenancy.ts above).
    check(
      "stock_movements_exclusive_arc_chk",
      sql`num_nonnulls(${t.saleId}, ${t.transferId}, ${t.stockCountId}, ${t.supplierDeliveryId}, ${t.sourceType}) = 1
          and (${t.sourceId} is null or ${t.sourceType} is not null)
          and (${t.sourceType} is null or ${t.sourceType} in ('manual', 'adjustment', 'opening'))`
    ),
  ]
);

export const stockLevels = pgTable(
  "stock_levels",
  {
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    avgCostMinor: bigint("avg_cost_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.structureId, t.productId, t.warehouseId] }),
    foreignKey({
      columns: [t.structureId, t.productId],
      foreignColumns: [products.structureId, products.id],
      name: "stock_levels_product_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.warehouseId],
      foreignColumns: [warehouses.structureId, warehouses.id],
      name: "stock_levels_warehouse_fk",
    }),
  ]
);
