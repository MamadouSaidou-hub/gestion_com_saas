import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  primaryKey,
  uniqueIndex,
  index,
  smallint,
  bigint,
  numeric,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Tenancy module: structures (tenants), memberships, invitations, currencies.
//
// IMPORTANT — user identity: Better Auth owns its own `user` table (and
// session/account/verification) via its own adapter migrations, which this
// Drizzle project does NOT create or manage, to avoid two migration owners
// fighting over the same table. `memberships.user_id` therefore has NO SQL
// foreign key to that table here — it is a bare `text` column (Better Auth's
// default id is a string, e.g. nanoid/cuid, not a uuid). Whoever wires Better
// Auth into this schema should, in a follow-up migration, either:
//   (a) add `references (user.id)` once that table exists in the same DB, or
//   (b) keep it FK-less and rely on the app layer for referential integrity.
// This is a deliberate judgment call — flag it to security-reviewer.
// ---------------------------------------------------------------------------

export const membershipRoleEnum = pgEnum("membership_role", [
  "owner",
  "manager",
  "cashier",
  "stock_keeper",
  "accountant",
  "auditor",
]);

export const membershipStatusEnum = pgEnum("membership_status", [
  "active",
  "invited",
  "suspended",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const valuationMethodEnum = pgEnum("valuation_method", [
  "cump", // weighted average cost (Coût Unitaire Moyen Pondéré) — only one implemented now
  "fifo", // reserved for a future projection, not built yet
]);

// Lookup table for D8: one currency per structure, minor-unit (bigint) amounts.
export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(), // ISO-ish code, e.g. 'XOF', 'GNF'
  name: text("name").notNull(),
  // Number of minor-unit decimal places. XOF/GNF have none (exponent 0), kept
  // generic so another currency with cents can be added without a migration.
  exponent: smallint("exponent").notNull().default(0),
});

export const structures = pgTable("structures", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  countryCode: text("country_code").notNull(), // 'SN' | 'GN' (not enforced by enum: more countries may be added)
  currencyCode: text("currency_code")
    .notNull()
    .references(() => currencies.code),
  // D9: valuation method is per-tenant config; only 'cump' projection logic
  // exists today, 'fifo' is reserved so no data migration is needed later.
  valuationMethod: valuationMethodEnum("valuation_method")
    .notNull()
    .default("cump"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id").notNull(), // Better Auth user id — see module note above
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").notNull(),
    status: membershipStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // --- Added by migration 0014 ---
    // A "gerant" is not a new role: it's a `manager` whose membership
    // carries a store (one store per member, NULL = all-stores scope).
    // Composite FK (structure_id, warehouse_id) -> warehouses(structure_id,
    // id) and the `role = 'owner' => warehouse_id is null` CHECK are added
    // by the hand-written SQL migration 0014 directly (not expressed here)
    // to avoid a tenancy<->catalog TS import cycle -- `warehouses` is
    // defined in catalog.ts, which already imports from this module.
    warehouseId: uuid("warehouse_id"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.structureId] }),
    // RLS policies and most lookups filter by structure_id first: index it.
    index("memberships_structure_id_idx").on(t.structureId),
    index("memberships_structure_warehouse_idx").on(t.structureId, t.warehouseId),
  ]
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: membershipRoleEnum("role").notNull(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull(), // Better Auth user id of the inviter
    // Store a hash of the invitation token, never the raw token (it's a
    // bearer secret mailed/texted to the invitee).
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("invitations_structure_id_idx").on(t.structureId),
    uniqueIndex("invitations_token_hash_idx").on(t.tokenHash),
  ]
);

// ---------------------------------------------------------------------------
// structure_settings (migration 0009): per-tenant business-policy config,
// kept separate from `structures` for the same reason `tax_settings` (0000)
// is separate — mutable operational knobs that grow over time, decoupled
// from the owner-gated tenant-identity row. One row per structure.
//
// `sodThresholdMinor` NULL = separation-of-duties (D3) disabled, the
// approved default for a brand new structure. `maxDiscountPct` NULL = no
// cap. Both are app-layer-enforced; this table only holds the config.
//
// RLS (0009): generic tenant floor (`tenant_access`), same convention as
// `tax_settings` — NOT role-restricted at the DB layer. Flagged for
// security-reviewer: the app layer MUST restrict writes here to `owner`,
// since a non-owner writing this row could defeat the SoD control itself.
// ---------------------------------------------------------------------------
export const structureSettings = pgTable(
  "structure_settings",
  {
    structureId: uuid("structure_id")
      .primaryKey()
      .references(() => structures.id, { onDelete: "cascade" }),
    sodThresholdMinor: bigint("sod_threshold_minor", { mode: "bigint" }),
    maxDiscountPct: numeric("max_discount_pct", { precision: 5, scale: 2 }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "structure_settings_sod_threshold_nonneg_chk",
      sql`${t.sodThresholdMinor} is null or ${t.sodThresholdMinor} >= 0`
    ),
    check(
      "structure_settings_max_discount_pct_range_chk",
      sql`${t.maxDiscountPct} is null or (${t.maxDiscountPct} >= 0 and ${t.maxDiscountPct} <= 100)`
    ),
  ]
);
