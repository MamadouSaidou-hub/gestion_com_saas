import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigint,
  numeric,
  uniqueIndex,
  unique,
  index,
  foreignKey,
  check,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { structures, currencies } from "./tenancy";

// ---------------------------------------------------------------------------
// Catalog module: products, categories, units, warehouses, suppliers,
// customers. Every table is tenant-scoped via `structure_id`, and every
// intra-tenant FK is COMPOSITE (structure_id, x_id) -> target(structure_id,
// id) so a row can never reference another tenant's row at the DB level.
// ---------------------------------------------------------------------------

export const units = pgTable(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    code: text("code").notNull(), // e.g. 'pcs', 'kg', 'l'
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("units_structure_id_idx").on(t.structureId),
    uniqueIndex("units_structure_code_idx").on(t.structureId, t.code),
    // Required for other tables' composite FK (structure_id, unit_id) ->
    // units(structure_id, id): Postgres needs an exact unique constraint
    // match on the referenced columns, `id` alone being PK is not enough.
    unique("units_structure_id_id_idx").on(t.structureId, t.id),
  ]
);

export const productCategories = pgTable(
  "product_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"), // composite self-FK, see below
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("product_categories_structure_id_idx").on(t.structureId),
    index("product_categories_parent_idx").on(t.structureId, t.parentId),
    // Required target for the composite self-FK and for products.category_fk.
    unique("product_categories_structure_id_id_idx").on(t.structureId, t.id),
    // Composite self-reference: a category's parent must belong to the same tenant.
    foreignKey({
      columns: [t.structureId, t.parentId],
      foreignColumns: [t.structureId, t.id],
      name: "product_categories_parent_fk",
    }),
  ]
);

// Added by migration 0014: a store (kind='store') is a selling location the
// POS warehouse selector offers; a depot (kind='depot') is a non-selling
// stock location -- both accept stock movements/counts/transfers. "Store"
// maps onto this existing table rather than a new `stores` table, since
// stock_movements/stock_levels/sales already composite-FK onto it.
export const warehouseKindEnum = pgEnum("warehouse_kind", ["store", "depot"]);

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // --- Added by migration 0014 ---
    code: text("code").notNull(), // short, tenant-unique, for references/CSV
    kind: warehouseKindEnum("kind").notNull().default("store"),
    isActive: boolean("is_active").notNull().default(true),
    address: text("address"),
    phone: text("phone"), // E.164, clear text, tenant-scoped (D7), same convention as suppliers/customers.phone
  },
  (t) => [
    index("warehouses_structure_id_idx").on(t.structureId),
    // Required for other tables' composite FK (structure_id, warehouse_id).
    unique("warehouses_structure_id_id_idx").on(t.structureId, t.id),
    uniqueIndex("warehouses_structure_code_idx").on(t.structureId, t.code),
    index("warehouses_structure_kind_idx").on(t.structureId, t.kind),
    check("warehouses_code_nonempty_chk", sql`length(btrim(${t.code})) > 0`),
  ]
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"), // E.164, clear text, tenant-scoped (per D7)
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("suppliers_structure_id_idx").on(t.structureId),
    // Added by hand-written migration 0003 (security-reviewer finding M1):
    // required for future purchasing tables' composite FK
    // (structure_id, supplier_id) -> suppliers(structure_id, id), consistent
    // with every other parent table in this file. Kept in sync here so
    // `drizzle-kit generate` does not see drift against 0003's `ALTER TABLE`.
    unique("suppliers_structure_id_id_idx").on(t.structureId, t.id),
  ]
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"), // E.164, clear text, tenant-scoped (per D7)
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("customers_structure_id_idx").on(t.structureId),
    index("customers_phone_idx").on(t.structureId, t.phone),
    // Required for other tables' composite FK (structure_id, customer_id).
    unique("customers_structure_id_id_idx").on(t.structureId, t.id),
  ]
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id"),
    unitId: uuid("unit_id").notNull(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    // D8: every monetary row carries its own currency_code, denormalized from
    // the tenant rather than inferred, even though v1 has one currency/tenant.
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    defaultPriceMinor: bigint("default_price_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Added by hand-written migration 0009: the /produits screen's low-stock
    // badge needs this; NULL = no threshold configured (no badge shown).
    lowStockThreshold: numeric("low_stock_threshold", { precision: 18, scale: 4 }),
    // Added by hand-written migration 0009: seeds stock_levels'/sale_lines'
    // CUMP cost when a product is first created, before any purchase exists.
    defaultCostMinor: bigint("default_cost_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    index("products_structure_id_idx").on(t.structureId),
    uniqueIndex("products_structure_sku_idx").on(t.structureId, t.sku),
    index("products_category_idx").on(t.structureId, t.categoryId),
    index("products_unit_idx").on(t.structureId, t.unitId),
    // Required for other tables' composite FK (structure_id, product_id).
    unique("products_structure_id_id_idx").on(t.structureId, t.id),
    foreignKey({
      columns: [t.structureId, t.categoryId],
      foreignColumns: [productCategories.structureId, productCategories.id],
      name: "products_category_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.unitId],
      foreignColumns: [units.structureId, units.id],
      name: "products_unit_fk",
    }),
    check(
      "products_low_stock_threshold_nonneg_chk",
      sql`${t.lowStockThreshold} is null or ${t.lowStockThreshold} >= 0`
    ),
  ]
);
