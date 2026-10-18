import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  numeric,
  boolean,
  pgEnum,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { structures, currencies } from "./tenancy";
import { customers, suppliers } from "./catalog";

// ---------------------------------------------------------------------------
// Added by migration 0016: generic, quantity-driven, cliff-mode rebate
// scales. STRICTLY INFORMATIONAL -- never auto-deducted from any
// receivable/debt. Exactly one of customerId/supplierId per scale (two
// explicit composite-FK columns + a CHECK, NOT a partyType/partyId
// polymorph -- applying the db/README.md 2r lesson preventively).
//
// Customer side = monthly (period derived from now(), never stored as a
// counter). Supplier side = cyclic, no time limit, auto-triggered on
// delivery, tier granted = the HIGHEST tier reached.
//
// CRITICAL INVARIANT, enforced structurally in rebateGrants below: NO
// foreign key to payments/invoices/supplierPayments/any balance column.
// Rebates are informational only. See that table's own comment.
//
// RLS: generic tenant floor only for all three tables (no store predicate --
// rebates are computed at customer/supplier granularity, already
// tenant-consolidated, same reasoning as supplierPayments in purchasing.ts).
// ---------------------------------------------------------------------------

export const rebateModelEnum = pgEnum("rebate_model", ["monthly", "cyclic"]);

// Only 'cliff' exists today (reaching a tier rebates ALL counted units, not
// just the ones above the threshold). An enum, not a boolean, so a future
// "marginal" mode can be added without a column-type change.
export const rebateModeEnum = pgEnum("rebate_mode", ["cliff"]);

export const rebateGrantTriggerEnum = pgEnum("rebate_grant_trigger", ["manual", "auto"]);

export const rebateScales = pgTable(
  "rebate_scales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id"),
    supplierId: uuid("supplier_id"),
    model: rebateModelEnum("model").notNull(),
    mode: rebateModeEnum("mode").notNull().default("cliff"),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    // Meaningful ONLY for the cyclic (supplier) model -- must stay NULL for
    // a monthly (customer) scale, enforced by the CHECK below.
    cycleStartedAt: timestamp("cycle_started_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").notNull(), // Better Auth user id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rebate_scales_structure_id_idx").on(t.structureId),
    unique("rebate_scales_structure_id_id_key").on(t.structureId, t.id),
    // One scale per customer / per supplier (partial -- the column may be
    // NULL for the other party).
    uniqueIndex("rebate_scales_structure_customer_idx")
      .on(t.structureId, t.customerId)
      .where(sql`${t.customerId} is not null`),
    uniqueIndex("rebate_scales_structure_supplier_idx")
      .on(t.structureId, t.supplierId)
      .where(sql`${t.supplierId} is not null`),
    foreignKey({
      columns: [t.structureId, t.customerId],
      foreignColumns: [customers.structureId, customers.id],
      name: "rebate_scales_customer_fk",
    }),
    foreignKey({
      columns: [t.structureId, t.supplierId],
      foreignColumns: [suppliers.structureId, suppliers.id],
      name: "rebate_scales_supplier_fk",
    }),
    // Structural guard against a partyType/partyId polymorph (2r, applied
    // preventively this time).
    check("rebate_scales_exactly_one_party_chk", sql`num_nonnulls(${t.customerId}, ${t.supplierId}) = 1`),
    check(
      "rebate_scales_cycle_started_at_model_chk",
      sql`${t.model} = 'cyclic' or ${t.cycleStartedAt} is null`
    ),
    check(
      "rebate_scales_party_model_chk",
      sql`(${t.customerId} is not null and ${t.model} = 'monthly')
          or (${t.supplierId} is not null and ${t.model} = 'cyclic')`
    ),
  ]
);

export const rebateTiers = pgTable(
  "rebate_tiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    scaleId: uuid("scale_id").notNull(),
    thresholdQty: numeric("threshold_qty", { precision: 18, scale: 4 }).notNull(),
    rebatePerUnitMinor: bigint("rebate_per_unit_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
  },
  (t) => [
    index("rebate_tiers_structure_id_idx").on(t.structureId),
    index("rebate_tiers_scale_idx").on(t.structureId, t.scaleId),
    foreignKey({
      columns: [t.structureId, t.scaleId],
      foreignColumns: [rebateScales.structureId, rebateScales.id],
      name: "rebate_tiers_scale_fk",
    }),
    // Spec names this unique(scale_id, threshold_qty); structure_id leads
    // per this project's universal composite-unique-key convention -- same
    // uniqueness, scale_id already pins the tenant transitively.
    unique("rebate_tiers_structure_scale_threshold_key").on(t.structureId, t.scaleId, t.thresholdQty),
    check("rebate_tiers_threshold_positive_chk", sql`${t.thresholdQty} > 0`),
    check("rebate_tiers_rebate_per_unit_nonneg_chk", sql`${t.rebatePerUnitMinor} >= 0`),
  ]
);

// `rebateGrants` is a HISTORY table. CRITICAL INVARIANT: no FK, and must
// never be one, to payments/invoices/supplierPayments or any balance
// column -- a rebate is informational only, never auto-deducted. Its only
// FK target is rebateScales. Any future migration adding a money-movement
// FK here must update this comment, which is the trip-wire for a
// security-reviewer pass before merge.
export const rebateGrants = pgTable(
  "rebate_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    scaleId: uuid("scale_id").notNull(),
    // Denormalized copy of rebateScales.model AT GRANT TIME -- a grant is a
    // historical fact, kept correct even if the scale's model were ever
    // changed later (no such mutation exists today). Also what makes the
    // monthly-only partial unique index below expressible without a
    // correlated subquery in the index predicate.
    model: rebateModelEnum("model").notNull(),
    periodLabel: text("period_label"), // required for monthly, always NULL for cyclic
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    countedQty: numeric("counted_qty", { precision: 18, scale: 4 }).notNull(),
    tierThresholdQty: numeric("tier_threshold_qty", { precision: 18, scale: 4 }).notNull(),
    rebatePerUnitMinor: bigint("rebate_per_unit_minor", { mode: "bigint" }).notNull(),
    totalRebateMinor: bigint("total_rebate_minor", { mode: "bigint" }).notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    grantedBy: text("granted_by"), // Better Auth user id; NULL only when trigger = 'auto'
    trigger: rebateGrantTriggerEnum("trigger").notNull(),
  },
  (t) => [
    index("rebate_grants_structure_id_idx").on(t.structureId),
    index("rebate_grants_scale_idx").on(t.structureId, t.scaleId),
    index("rebate_grants_granted_at_idx").on(t.structureId, t.grantedAt),
    foreignKey({
      columns: [t.structureId, t.scaleId],
      foreignColumns: [rebateScales.structureId, rebateScales.id],
      name: "rebate_grants_scale_fk",
    }),
    // Monthly-only partial unique index -- cyclic grants (periodLabel always
    // NULL) coexist freely; Postgres never treats multiple NULLs as
    // duplicates in a unique index.
    uniqueIndex("rebate_grants_structure_scale_period_label_idx")
      .on(t.structureId, t.scaleId, t.periodLabel)
      .where(sql`${t.model} = 'monthly'`),
    check("rebate_grants_period_consistency_chk", sql`${t.periodEnd} >= ${t.periodStart}`),
    check(
      "rebate_grants_period_label_model_chk",
      sql`(${t.model} = 'monthly') = (${t.periodLabel} is not null)`
    ),
    check(
      "rebate_grants_granted_by_trigger_chk",
      sql`(${t.trigger} = 'manual') = (${t.grantedBy} is not null)`
    ),
    check(
      "rebate_grants_counted_qty_nonneg_chk",
      sql`${t.countedQty} >= 0 and ${t.tierThresholdQty} > 0 and ${t.rebatePerUnitMinor} >= 0 and ${t.totalRebateMinor} >= 0`
    ),
  ]
);
