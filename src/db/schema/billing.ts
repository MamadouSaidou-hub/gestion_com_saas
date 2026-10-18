import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  numeric,
  integer,
  pgEnum,
  primaryKey,
  uniqueIndex,
  unique,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { structures, currencies } from "./tenancy";
import { customers } from "./catalog";
import { sales } from "./sales";

// ---------------------------------------------------------------------------
// Billing module (D4): per-tenant tax/legal config, gapless document
// numbering, invoices, payments, payment allocations.
// ---------------------------------------------------------------------------

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "issued",
  "paid",
  "partially_paid",
  "cancelled",
]);

export const documentTypeEnum = pgEnum("document_type", [
  "invoice",
  "quote",
  "credit_note",
  "delivery_note",
  // Added by migration 0009 (ALTER TYPE ... ADD VALUE): tickets get their
  // own gapless counter in `document_counters`, independent from invoices,
  // per the "tickets by default, invoice on demand" decision.
  "ticket",
  // Added by migration 0014 (ALTER TYPE ... ADD VALUE): inter-store
  // transfers get their own gapless counter (stock_transfers.reference).
  "transfer",
]);

// One row per tenant: VAT rate, legal mentions, invoice prefix. Config, not
// hardcoded — no DGI/certified e-invoicing integration in v1 (see CLAUDE.md D4).
export const taxSettings = pgTable("tax_settings", {
  structureId: uuid("structure_id")
    .primaryKey()
    .references(() => structures.id, { onDelete: "cascade" }),
  vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  legalMentions: text("legal_mentions"),
  invoicePrefix: text("invoice_prefix"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Gapless numbering source: the app must `SELECT ... FOR UPDATE` this row,
// read next_value, use it, then UPDATE next_value = next_value + 1 in the
// same transaction. Not built here — just the table the app layer needs.
export const documentCounters = pgTable(
  "document_counters",
  {
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    docType: documentTypeEnum("doc_type").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    nextValue: bigint("next_value", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.structureId, t.docType, t.fiscalYear] }),
  ]
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id"),
    customerId: uuid("customer_id"),
    docNumber: text("doc_number").notNull(), // produced via document_counters
    fiscalYear: integer("fiscal_year").notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    totalMinor: bigint("total_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // --- Added by migration 0009 ---
    // Denormalized, maintained in-transaction by the app, so receivables
    // ("en attente") don't need an aggregate join on every dashboard load.
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // Composite self-FK: a credit note references the invoice it credits,
    // in the same tenant (same pattern as product_categories.parent_id).
    creditNoteOfInvoiceId: uuid("credit_note_of_invoice_id"),
  },
  (t) => [
    index("invoices_structure_id_idx").on(t.structureId),
    index("invoices_customer_idx").on(t.structureId, t.customerId),
    index("invoices_sale_idx").on(t.structureId, t.saleId),
    // Added by migration 0011: the arbiter for issueInvoiceForSale's
    // idempotent-ish "ask twice, get the same invoice" behavior -- a
    // partial unique index (not all invoices have a sale_id: a standalone
    // invoice with no prior ticket is still a valid document_type).
    uniqueIndex("invoices_structure_sale_id_unique_idx")
      .on(t.structureId, t.saleId)
      .where(sql`${t.saleId} is not null`),
    // Doc numbers must be unique per tenant+fiscal year (gapless numbering).
    uniqueIndex("invoices_structure_fy_docnumber_idx").on(
      t.structureId,
      t.fiscalYear,
      t.docNumber
    ),
    // Required for payment_allocations' composite FK (structure_id, invoice_id).
    unique("invoices_structure_id_id_idx").on(t.structureId, t.id),
    foreignKey({
      columns: [t.structureId, t.customerId],
      foreignColumns: [customers.structureId, customers.id],
      name: "invoices_customer_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.saleId],
      foreignColumns: [sales.structureId, sales.id],
      name: "invoices_sale_fk",
    }),
    // Added by migration 0009:
    foreignKey({
      columns: [t.structureId, t.creditNoteOfInvoiceId],
      foreignColumns: [t.structureId, t.id],
      name: "invoices_credit_note_of_invoice_fk",
    }),
    index("invoices_credit_note_of_invoice_idx").on(t.structureId, t.creditNoteOfInvoiceId),
    check("invoices_paid_le_total_chk", sql`${t.paidMinor} <= ${t.totalMinor}`),
    // Dashboard index: receivables + overdue.
    index("invoices_structure_status_due_idx").on(t.structureId, t.status, t.dueAt),
  ]
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id"),
    // --- Added by migration 0010 ---
    // Links a payment collected AT sale-confirmation time back to the sale
    // it paid for -- nullable because a payment can also be recorded later,
    // standalone, against an invoice (payment_allocations), independent of
    // any single sale. Composite-FK'd like every other intra-tenant
    // reference (see "Composite FK pattern" in db/README.md). Gap found
    // while implementing confirmSale (step 9: "insert the payment ... set
    // the sale's payment_status") -- 0009 added sales.payment_status but no
    // column anywhere linked a payment row to the sale it was collected
    // for (invoices.sale_id exists, but tickets-by-default means no
    // invoice exists yet at confirmation time).
    saleId: uuid("sale_id"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    method: text("method").notNull(), // 'cash', 'mobile_money', 'bank_transfer', ...
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // --- Added by migration 0009 ---
    // Money-correctness mechanism for the PWA retry queue, mirroring sales.
    idempotencyKey: text("idempotency_key").notNull(),
    reference: text("reference"), // mobile money transaction ref
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    // --- Added by migration 0014 ---
    // Treasury-per-store: backfilled from sales.warehouse_id, falling back
    // to the structure's default store. Composite FK -> warehouses added by
    // the hand-written SQL migration (see catalog.ts import-cycle note on
    // memberships.warehouseId above for why this isn't a `.references()`
    // thunk here either -- same reasoning, billing.ts does not import
    // catalog.ts's warehouses table to avoid widening the import graph).
    warehouseId: uuid("warehouse_id"),
  },
  (t) => [
    index("payments_structure_id_idx").on(t.structureId),
    index("payments_customer_idx").on(t.structureId, t.customerId),
    index("payments_structure_warehouse_idx").on(t.structureId, t.warehouseId),
    // Required for payment_allocations' composite FK (structure_id, payment_id).
    unique("payments_structure_id_id_idx").on(t.structureId, t.id),
    foreignKey({
      columns: [t.structureId, t.customerId],
      foreignColumns: [customers.structureId, customers.id],
      name: "payments_customer_fk",
    }),
    // Added by migration 0009:
    unique("payments_structure_idempotency_key_key").on(t.structureId, t.idempotencyKey),
    index("payments_structure_received_idx").on(t.structureId, t.receivedAt),
    // Added by migration 0010:
    foreignKey({
      columns: [t.structureId, t.saleId],
      foreignColumns: [sales.structureId, sales.id],
      name: "payments_sale_fk",
    }),
    index("payments_structure_sale_idx").on(t.structureId, t.saleId),
  ]
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
  },
  (t) => [
    index("payment_allocations_structure_id_idx").on(t.structureId),
    index("payment_allocations_payment_idx").on(t.structureId, t.paymentId),
    index("payment_allocations_invoice_idx").on(t.structureId, t.invoiceId),
    foreignKey({
      columns: [t.structureId, t.paymentId],
      foreignColumns: [payments.structureId, payments.id],
      name: "payment_allocations_payment_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.invoiceId],
      foreignColumns: [invoices.structureId, invoices.id],
      name: "payment_allocations_invoice_fk",
    }),
  ]
);
