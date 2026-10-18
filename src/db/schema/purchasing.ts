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
import { suppliers, warehouses, products } from "./catalog";

// ---------------------------------------------------------------------------
// Added by migration 0015: supplier-side purchasing. Deliberately NOT
// reusing payments/invoices (customer-side by construction) -- adding a
// party_type column to those would recreate exactly the polymorphic
// reference 0009/0014 spent two migrations retiring (see db/README.md 2r).
//
// Floor vs ceiling RLS scoping (db/README.md entry 2z mirrors 0014's 2x):
//   - supplierDeliveries        FLOOR: tenant floor + store predicate
//                                (carries warehouseId directly).
//   - supplierDeliveryLines     FLOOR: tenant floor only (line table).
//   - supplierPayments          FLOOR: tenant floor only, DELIBERATELY not
//                                store-scoped -- supplier debt is
//                                consolidated at TENANT level by product
//                                decision; this table has no warehouseId.
//   - supplierPaymentAllocations FLOOR: tenant floor only (line-shaped,
//                                mirrors paymentAllocations).
//
// Composite FKs to `warehouses` (supplierDeliveries.warehouseId) and the
// store-scope RLS predicate are added by the hand-written SQL migration
// (0015), not expressed as `.references()`/`foreignKey()` here, for the
// warehouse one specifically -- same import-cycle avoidance reasoning
// already used for stock_transfers/stock_counts in stock-transfers.ts.
// ---------------------------------------------------------------------------

export const deliveryPaymentStatusEnum = pgEnum("delivery_payment_status", [
  "unpaid",
  "partial",
  "paid",
]);

export const supplierDeliveries = pgTable(
  "supplier_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    reference: text("reference").notNull(), // allocated via document_counters, doc_type = 'delivery'
    fiscalYear: integer("fiscal_year").notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull().default(sql`0`),
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
    paymentStatus: deliveryPaymentStatusEnum("payment_status").notNull().default("unpaid"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    index("supplier_deliveries_structure_id_idx").on(t.structureId),
    index("supplier_deliveries_supplier_idx").on(t.structureId, t.supplierId),
    index("supplier_deliveries_warehouse_idx").on(t.structureId, t.warehouseId),
    index("supplier_deliveries_payment_status_due_idx").on(t.structureId, t.paymentStatus, t.dueAt),
    unique("supplier_deliveries_structure_id_id_key").on(t.structureId, t.id),
    unique("supplier_deliveries_structure_idempotency_key_key").on(t.structureId, t.idempotencyKey),
    unique("supplier_deliveries_structure_fy_reference_idx").on(t.structureId, t.fiscalYear, t.reference),
    foreignKey({
      columns: [t.structureId, t.supplierId],
      foreignColumns: [suppliers.structureId, suppliers.id],
      name: "supplier_deliveries_supplier_fk",
    }),
    // Composite FK to warehouses added by the hand-written SQL migration
    // (0015) -- see header note.
    check("supplier_deliveries_paid_le_total_chk", sql`${t.paidMinor} <= ${t.totalMinor}`),
    check("supplier_deliveries_total_nonneg_chk", sql`${t.totalMinor} >= 0 and ${t.paidMinor} >= 0`),
    check(
      "supplier_deliveries_cancelled_by_consistency_chk",
      sql`${t.cancelledBy} is null or ${t.cancelledAt} is not null`
    ),
    check(
      "supplier_deliveries_cancel_reason_consistency_chk",
      sql`${t.cancelReason} is null or ${t.cancelledAt} is not null`
    ),
  ]
);

export const supplierDeliveryLines = pgTable(
  "supplier_delivery_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
    lineNo: smallint("line_no").notNull().default(1),
  },
  (t) => [
    index("supplier_delivery_lines_structure_id_idx").on(t.structureId),
    index("supplier_delivery_lines_delivery_idx").on(t.structureId, t.deliveryId),
    index("supplier_delivery_lines_product_idx").on(t.structureId, t.productId),
    foreignKey({
      columns: [t.structureId, t.deliveryId],
      foreignColumns: [supplierDeliveries.structureId, supplierDeliveries.id],
      name: "supplier_delivery_lines_delivery_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.productId],
      foreignColumns: [products.structureId, products.id],
      name: "supplier_delivery_lines_product_fk",
    }),
    unique("supplier_delivery_lines_structure_delivery_line_no_key").on(t.structureId, t.deliveryId, t.lineNo),
    check("supplier_delivery_lines_quantity_positive_chk", sql`${t.quantity} > 0`),
    check("supplier_delivery_lines_unit_cost_nonneg_chk", sql`${t.unitCostMinor} >= 0`),
    check("supplier_delivery_lines_line_total_nonneg_chk", sql`${t.lineTotalMinor} >= 0`),
  ]
);

export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id").notNull(),
    // Nullable: a standalone payment on account, not yet allocated to any
    // delivery, is a valid state (mirrors payments.saleId's nullability).
    deliveryId: uuid("delivery_id"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    method: text("method").notNull(), // 'cash', 'mobile_money', 'bank_transfer', ...
    reference: text("reference"), // mobile money transaction ref
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key").notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    // Deliberately NO warehouseId -- see module header comment: supplier
    // debt is consolidated at tenant level, not store-owned.
  },
  (t) => [
    index("supplier_payments_structure_id_idx").on(t.structureId),
    index("supplier_payments_supplier_idx").on(t.structureId, t.supplierId),
    index("supplier_payments_delivery_idx").on(t.structureId, t.deliveryId),
    index("supplier_payments_paid_at_idx").on(t.structureId, t.paidAt),
    unique("supplier_payments_structure_id_id_key").on(t.structureId, t.id),
    unique("supplier_payments_structure_idempotency_key_key").on(t.structureId, t.idempotencyKey),
    foreignKey({
      columns: [t.structureId, t.supplierId],
      foreignColumns: [suppliers.structureId, suppliers.id],
      name: "supplier_payments_supplier_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.deliveryId],
      foreignColumns: [supplierDeliveries.structureId, supplierDeliveries.id],
      name: "supplier_payments_delivery_fk",
    }),
    check("supplier_payments_amount_positive_chk", sql`${t.amountMinor} > 0`),
  ]
);

export const supplierPaymentAllocations = pgTable(
  "supplier_payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    supplierPaymentId: uuid("supplier_payment_id").notNull(),
    deliveryId: uuid("delivery_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
  },
  (t) => [
    index("supplier_payment_allocations_structure_id_idx").on(t.structureId),
    index("supplier_payment_allocations_payment_idx").on(t.structureId, t.supplierPaymentId),
    index("supplier_payment_allocations_delivery_idx").on(t.structureId, t.deliveryId),
    foreignKey({
      columns: [t.structureId, t.supplierPaymentId],
      foreignColumns: [supplierPayments.structureId, supplierPayments.id],
      name: "supplier_payment_allocations_payment_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.deliveryId],
      foreignColumns: [supplierDeliveries.structureId, supplierDeliveries.id],
      name: "supplier_payment_allocations_delivery_fk",
    }),
    check("supplier_payment_allocations_amount_positive_chk", sql`${t.amountMinor} > 0`),
  ]
);
