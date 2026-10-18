import { pgTable, bigint, uuid, text, jsonb, customType, timestamp, index } from "drizzle-orm/pg-core";
import { structures } from "./tenancy";

// ---------------------------------------------------------------------------
// Audit module (D10): append-only, hash-chained PER TENANT (not a single
// global chain — avoids cross-tenant contention and metadata leakage).
//
// This file only declares the table shape for typed reads/inserts. The
// hash-chaining trigger, the immutability triggers, the `audit_log_append`
// SECURITY DEFINER function, the `audit_log_verify` function, and the
// REVOKE/GRANT statements are all in the hand-written SQL migration
// (0001_tenancy_rls_audit.sql) because drizzle-kit cannot express triggers,
// functions or grants. `app_user` has NO direct INSERT/UPDATE/DELETE on this
// table — it only has EXECUTE on `audit_log_append(...)`.
// ---------------------------------------------------------------------------

// bytea custom type (drizzle-orm has no first-class pg bytea helper).
const bytea = customType<{ data: Buffer; driverData: string }>({
  dataType() {
    return "bytea";
  },
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    // No ON DELETE CASCADE: a tenant's audit history must outlive a tenant
    // deactivation (compliance). Structures are never hard-deleted by the
    // app anyway (no DELETE RLS policy on `structures`), so this is belt
    // and suspenders, not a practical blocker.
    structureId: uuid("structure_id")
      .notNull()
      .references(() => structures.id),
    actorId: text("actor_id"), // Better Auth user id; nullable for system actions
    actorRole: text("actor_role"),
    action: text("action").notNull(), // e.g. 'sale.confirmed', 'invoice.issued'
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    payload: jsonb("payload").notNull().default({}),
    prevHash: bytea("prev_hash").notNull(),
    entryHash: bytea("entry_hash").notNull(),
    seq: bigint("seq", { mode: "bigint" }).notNull(), // per-tenant sequence number, set by the trigger
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestId: text("request_id"),
  },
  (t) => [
    index("audit_log_structure_id_idx").on(t.structureId),
    index("audit_log_structure_seq_idx").on(t.structureId, t.seq),
  ]
);
