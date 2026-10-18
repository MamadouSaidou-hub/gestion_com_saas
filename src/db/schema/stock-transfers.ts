import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  numeric,
  integer,
  smallint,
  pgEnum,
  index,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { structures, currencies } from "./tenancy";
import { products } from "./catalog";

// ---------------------------------------------------------------------------
// Added by migration 0014: inter-store transfers (stock_transfers /
// stock_transfer_lines) and physical stock counts (stock_counts /
// stock_count_lines) -- headers + lines only for stock_counts, the use
// cases (open/validate/cancel) ship in a later phase.
//
// RLS note (see db/README.md "floor/ceiling split"): the HEADER tables
// (stock_transfers, stock_counts) carry a warehouse_id (or two, for
// transfers) and are store-scoped by migration 0014's RLS rewrite. The LINE
// tables (stock_transfer_lines, stock_count_lines) are floor-only -- they
// are only ever reached by joining an already store-scoped header, and a
// correlated per-row EXISTS would defeat index-only dashboard aggregates.
// ---------------------------------------------------------------------------

export const stockTransferStatusEnum = pgEnum("stock_transfer_status", [
  "in_transit",
  "received",
  "cancelled",
]);

export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    reference: text("reference").notNull(), // allocated via document_counters, doc_type = 'transfer'
    fiscalYear: integer("fiscal_year").notNull(),
    fromWarehouseId: uuid("from_warehouse_id").notNull(),
    toWarehouseId: uuid("to_warehouse_id").notNull(),
    status: stockTransferStatusEnum("status").notNull().default("in_transit"),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    receivedBy: text("received_by"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    // PWA retry-queue de-duplication key, same mechanism as sales/payments.
    idempotencyKey: text("idempotency_key").notNull(),
    // sha256 fingerprint of the request payload (H1 defense, mirrors
    // sales.requestFingerprint, migration 0012): an idempotency-key replay
    // with a DIFFERENT payload must be refused, not silently returned.
    requestFingerprint: text("request_fingerprint").notNull(),
  },
  (t) => [
    index("stock_transfers_structure_id_idx").on(t.structureId),
    index("stock_transfers_from_warehouse_idx").on(t.structureId, t.fromWarehouseId),
    index("stock_transfers_to_warehouse_idx").on(t.structureId, t.toWarehouseId),
    index("stock_transfers_status_idx").on(t.structureId, t.status),
    unique("stock_transfers_structure_id_id_key").on(t.structureId, t.id),
    unique("stock_transfers_structure_idempotency_key_key").on(t.structureId, t.idempotencyKey),
    unique("stock_transfers_structure_fy_reference_idx").on(t.structureId, t.fiscalYear, t.reference),
    // Composite FKs to warehouses are added by the hand-written SQL
    // migration (0014), not expressed here, to avoid importing catalog.ts's
    // `warehouses` table into this module purely for FK declarations.
    check("stock_transfers_distinct_warehouses_chk", sql`${t.fromWarehouseId} <> ${t.toWarehouseId}`),
    check(
      "stock_transfers_received_consistency_chk",
      sql`(${t.status} = 'received') = (${t.receivedAt} is not null)`
    ),
    check(
      "stock_transfers_received_by_consistency_chk",
      sql`(${t.status} = 'received') = (${t.receivedBy} is not null)`
    ),
    check(
      "stock_transfers_cancelled_consistency_chk",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`
    ),
    check(
      "stock_transfers_cancelled_by_consistency_chk",
      sql`(${t.status} = 'cancelled') = (${t.cancelledBy} is not null)`
    ),
    check(
      "stock_transfers_cancel_reason_consistency_chk",
      sql`${t.status} = 'cancelled' or ${t.cancelReason} is null`
    ),
  ]
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    transferId: uuid("transfer_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    // CUMP cost snapshot AT DEPARTURE -- the receiving warehouse's own CUMP
    // projection needs a cost to post the incoming movement at.
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull(),
    lineNo: smallint("line_no").notNull().default(1),
  },
  (t) => [
    index("stock_transfer_lines_structure_id_idx").on(t.structureId),
    index("stock_transfer_lines_transfer_idx").on(t.structureId, t.transferId),
    index("stock_transfer_lines_product_idx").on(t.structureId, t.productId),
    foreignKey({
      columns: [t.structureId, t.transferId],
      foreignColumns: [stockTransfers.structureId, stockTransfers.id],
      name: "stock_transfer_lines_transfer_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.productId],
      foreignColumns: [products.structureId, products.id],
      name: "stock_transfer_lines_product_fk",
    }),
    unique("stock_transfer_lines_structure_transfer_line_no_key").on(t.structureId, t.transferId, t.lineNo),
    check("stock_transfer_lines_quantity_positive_chk", sql`${t.quantity} > 0`),
    check("stock_transfer_lines_unit_cost_nonneg_chk", sql`${t.unitCostMinor} >= 0`),
  ]
);

export const stockCountStatusEnum = pgEnum("stock_count_status", [
  "draft",
  "validated",
  "cancelled",
]);

export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id").notNull(),
    status: stockCountStatusEnum("status").notNull().default("draft"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    validatedBy: text("validated_by"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (t) => [
    index("stock_counts_structure_id_idx").on(t.structureId),
    index("stock_counts_warehouse_idx").on(t.structureId, t.warehouseId),
    index("stock_counts_status_idx").on(t.structureId, t.status),
    unique("stock_counts_structure_id_id_key").on(t.structureId, t.id),
    unique("stock_counts_structure_idempotency_key_key").on(t.structureId, t.idempotencyKey),
    // Composite FK to warehouses added by the hand-written SQL migration
    // (0014), same import-cycle avoidance reasoning as stock_transfers above.
    check(
      "stock_counts_validated_consistency_chk",
      sql`(${t.status} = 'validated') = (${t.validatedAt} is not null)`
    ),
    check(
      "stock_counts_validated_by_consistency_chk",
      sql`(${t.status} = 'validated') = (${t.validatedBy} is not null)`
    ),
    check(
      "stock_counts_cancelled_consistency_chk",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`
    ),
    check(
      "stock_counts_cancelled_by_consistency_chk",
      sql`(${t.status} = 'cancelled') = (${t.cancelledBy} is not null)`
    ),
  ]
);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    stockCountId: uuid("stock_count_id").notNull(),
    productId: uuid("product_id").notNull(),
    theoreticalQty: numeric("theoretical_qty", { precision: 18, scale: 4 }).notNull(), // snapshot at open
    countedQty: numeric("counted_qty", { precision: 18, scale: 4 }), // NULL until counted
    varianceQty: numeric("variance_qty", { precision: 18, scale: 4 }), // app-maintained
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull().default(sql`0`),
    varianceValueMinor: bigint("variance_value_minor", { mode: "bigint" }), // app-maintained
  },
  (t) => [
    index("stock_count_lines_structure_id_idx").on(t.structureId),
    index("stock_count_lines_stock_count_idx").on(t.structureId, t.stockCountId),
    index("stock_count_lines_product_idx").on(t.structureId, t.productId),
    foreignKey({
      columns: [t.structureId, t.stockCountId],
      foreignColumns: [stockCounts.structureId, stockCounts.id],
      name: "stock_count_lines_stock_count_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.productId],
      foreignColumns: [products.structureId, products.id],
      name: "stock_count_lines_product_fk",
    }),
    unique("stock_count_lines_structure_count_product_key").on(t.structureId, t.stockCountId, t.productId),
    check("stock_count_lines_theoretical_qty_nonneg_chk", sql`${t.theoreticalQty} >= 0`),
    check("stock_count_lines_counted_qty_nonneg_chk", sql`${t.countedQty} is null or ${t.countedQty} >= 0`),
    check("stock_count_lines_unit_cost_nonneg_chk", sql`${t.unitCostMinor} >= 0`),
  ]
);
