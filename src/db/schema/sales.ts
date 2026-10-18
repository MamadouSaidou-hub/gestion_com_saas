import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  numeric,
  smallint,
  integer,
  pgEnum,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { structures, currencies } from "./tenancy";
import { customers, products, warehouses } from "./catalog";

// ---------------------------------------------------------------------------
// Sales module: sales (header) + sale_lines (detail). Tenant-scoped with the
// composite-FK pattern; monetary columns are bigint minor-unit + currency_code.
//
// Business decisions encoded here (migration 0009, approved 2026-10-17):
//  - Credit sales allowed: `paymentStatus` tracks unpaid/partial/paid; a
//    sale's total need not be collected at confirmation time.
//  - Tickets by default, invoice on demand: `ticketNumber` is this table's
//    own gapless counter (document_counters, doc_type='ticket'); an invoice
//    is a separate row (billing.ts) created later, independently.
//  - `idempotencyKey` is the money-correctness mechanism for the PWA retry
//    queue: a double-submit must hit the unique index below, not a
//    pre-SELECT race.
// ---------------------------------------------------------------------------

export const saleStatusEnum = pgEnum("sale_status", [
  "draft",
  "confirmed",
  "cancelled",
]);

// Added by migration 0009. Orthogonal to `saleStatusEnum` — a confirmed
// (non-cancelled) sale can be unpaid, partially paid, or fully paid; the
// app layer maintains this as payments are allocated.
export const salePaymentStatusEnum = pgEnum("sale_payment_status", [
  "unpaid",
  "partial",
  "paid",
]);

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id"),
    warehouseId: uuid("warehouse_id").notNull(),
    status: saleStatusEnum("status").notNull().default("draft"),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    totalMinor: bigint("total_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    // --- Added by migration 0009 ---
    // PWA retry-queue de-duplication key, set by the client at creation.
    idempotencyKey: text("idempotency_key").notNull(),
    // --- Added by migration 0012 ---
    // H1 (security-reviewer, High): a sha256 fingerprint of the request
    // payload (warehouse/customer/sorted lines/payment), set once at
    // first confirmation. On an idempotency-key replay, confirmSale
    // compares this against the NEW request's fingerprint -- a mismatch
    // means a reused key hides a DIFFERENT cart, which must be refused,
    // not silently returned as if it were the original sale.
    requestFingerprint: text("request_fingerprint").notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    vatMinor: bigint("vat_minor", { mode: "bigint" }).notNull().default(sql`0`),
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // Fiscal year the ticket number was allocated in (document_counters key).
    fiscalYear: integer("fiscal_year"),
    // Gapless per structure+fiscalYear, allocated at confirmation from
    // document_counters (doc_type='ticket'). NULL for draft sales.
    ticketNumber: bigint("ticket_number", { mode: "bigint" }),
    paymentStatus: salePaymentStatusEnum("payment_status")
      .notNull()
      .default("unpaid"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"), // Better Auth user id, bare text like createdBy
    voidReason: text("void_reason"),
    // --- Added by migration 0010 ---
    // Denormalized, maintained in-transaction by confirmSale (same pattern
    // as invoices.paid_minor) -- receivables ("en attente") for a sale with
    // no invoice yet don't need an aggregate join over `payments` on every
    // dashboard load. Gap found while implementing confirmSale step 9.
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
  },
  (t) => [
    index("sales_structure_id_idx").on(t.structureId),
    index("sales_customer_idx").on(t.structureId, t.customerId),
    index("sales_warehouse_idx").on(t.structureId, t.warehouseId),
    // Required for other tables' composite FK (structure_id, sale_id).
    unique("sales_structure_id_id_idx").on(t.structureId, t.id),
    foreignKey({
      columns: [t.structureId, t.customerId],
      foreignColumns: [customers.structureId, customers.id],
      name: "sales_customer_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.warehouseId],
      foreignColumns: [warehouses.structureId, warehouses.id],
      name: "sales_warehouse_fk",
    }),
    // Added by migration 0009:
    unique("sales_structure_idempotency_key_key").on(t.structureId, t.idempotencyKey),
    // Partial unique index — multiple draft rows legitimately share
    // ticketNumber = NULL; only assigned (confirmed) tickets must be unique
    // per structure+fiscal year.
    uniqueIndex("sales_structure_fy_ticket_idx")
      .on(t.structureId, t.fiscalYear, t.ticketNumber)
      .where(sql`${t.ticketNumber} is not null`),
    check(
      "sales_cancelled_consistency_chk",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`
    ),
    // Added by migration 0010, mirrors invoices_paid_le_total_chk.
    check("sales_paid_le_total_chk", sql`${t.paidMinor} <= ${t.totalMinor}`),
    // Dashboard indexes (CA, encaissé, en attente, per-seller breakdown,
    // cashier's "own sales only" scope).
    index("sales_structure_status_confirmed_idx").on(t.structureId, t.status, t.confirmedAt),
    index("sales_structure_created_by_confirmed_idx").on(
      t.structureId,
      t.createdBy,
      t.confirmedAt
    ),
  ]
);

export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
    // --- Added by migration 0009 ---
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull().default("0"),
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // CUMP cost snapshot at sale time — without it gross margin is
    // unknowable retroactively once stock_levels' moving average changes.
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    lineNo: smallint("line_no").notNull().default(1),
  },
  (t) => [
    index("sale_lines_structure_id_idx").on(t.structureId),
    index("sale_lines_sale_idx").on(t.structureId, t.saleId),
    index("sale_lines_product_idx").on(t.structureId, t.productId),
    foreignKey({
      columns: [t.structureId, t.saleId],
      foreignColumns: [sales.structureId, sales.id],
      name: "sale_lines_sale_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.productId],
      foreignColumns: [products.structureId, products.id],
      name: "sale_lines_product_fk",
    }),
    // Added by migration 0009:
    unique("sale_lines_structure_sale_line_no_key").on(t.structureId, t.saleId, t.lineNo),
    // Top-products-by-30-day-window aggregation: join to sales (filtered by
    // sales_structure_status_confirmed_idx) via saleId, group by product.
    // NOTE: the hand-written SQL migration (0009) additionally adds
    // `include (quantity, line_total_minor)` on this index for an
    // index-only scan — this drizzle-orm version's index() builder has no
    // `.include()` API, so that clause only exists in the SQL migration,
    // not here. Keep both in sync by hand if this index's key columns ever
    // change.
    index("sale_lines_structure_product_sale_idx").on(t.structureId, t.productId, t.saleId),
  ]
);
