import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { stockTransfers, stockTransferLines } from "@/db/schema/stock-transfers";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "@/modules/inventory";
import type {
  TransfersRepository,
  TransferHeaderRecord,
  TransferLineRecord,
  InsertDraftTransferInput,
  InsertTransferLineInput,
  ListTransfersFilter,
} from "../application/ports";

// Drizzle implementation -- the ONLY file in this module allowed to import
// `@/db/schema/stock-transfers` for the TRANSFERS tables (enforced by the
// ESLint layering rule).

type TransferRow = typeof stockTransfers.$inferSelect;
type TransferLineRow = typeof stockTransferLines.$inferSelect;

function headerToDomain(row: TransferRow): TransferHeaderRecord {
  return {
    id: row.id,
    structureId: row.structureId,
    reference: row.reference,
    fiscalYear: row.fiscalYear,
    fromWarehouseId: row.fromWarehouseId,
    toWarehouseId: row.toWarehouseId,
    status: row.status,
    currencyCode: row.currencyCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    receivedBy: row.receivedBy,
    receivedAt: row.receivedAt,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
  };
}

function lineToDomain(row: TransferLineRow): TransferLineRecord {
  return {
    id: row.id,
    transferId: row.transferId,
    productId: row.productId,
    quantity: Quantity.fromString(row.quantity),
    unitCostMinor: row.unitCostMinor,
    lineNo: row.lineNo,
  };
}

// Store-scope predicate helper, mirroring migration 0014's RLS policy for
// this table exactly: unrestricted when `storeScope` is null, otherwise
// either leg of the transfer may match (OR, not AND) -- this is the
// app-layer CEILING re-stating the RLS FLOOR in SQL, same convention as
// analytics' storeScope filters.
function storeScopeCondition(storeScope: string | null) {
  if (storeScope === null) {
    return undefined;
  }
  return or(eq(stockTransfers.fromWarehouseId, storeScope), eq(stockTransfers.toWarehouseId, storeScope));
}

export const transfersRepository: TransfersRepository = {
  async tryInsertDraft(
    ctx: TenantSessionContext,
    input: InsertDraftTransferInput
  ): Promise<TransferHeaderRecord | null> {
    const rows = await ctx.db
      .insert(stockTransfers)
      .values({
        structureId: ctx.actor.structureId,
        reference: input.reference,
        fiscalYear: input.fiscalYear,
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        status: "in_transit",
        currencyCode: input.currencyCode,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      })
      // The arbiter: a conflict here means a replay, full stop -- never
      // pre-SELECT to check first (same convention as sales' tryInsertDraft).
      .onConflictDoNothing({ target: [stockTransfers.structureId, stockTransfers.idempotencyKey] })
      .returning();
    return rows[0] ? headerToDomain(rows[0]) : null;
  },

  async findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<TransferHeaderRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(stockTransfers)
      .where(
        and(eq(stockTransfers.structureId, ctx.actor.structureId), eq(stockTransfers.idempotencyKey, idempotencyKey))
      )
      .limit(1);
    return row ? headerToDomain(row) : null;
  },

  async findById(ctx: TenantSessionContext, transferId: string): Promise<TransferHeaderRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.structureId, ctx.actor.structureId), eq(stockTransfers.id, transferId)))
      .limit(1);
    return row ? headerToDomain(row) : null;
  },

  async insertLines(
    ctx: TenantSessionContext,
    transferId: string,
    lines: InsertTransferLineInput[]
  ): Promise<TransferLineRecord[]> {
    if (lines.length === 0) {
      return [];
    }
    const rows = await ctx.db
      .insert(stockTransferLines)
      .values(
        lines.map((line) => ({
          structureId: ctx.actor.structureId,
          transferId,
          productId: line.productId,
          quantity: line.quantity.toDbString(),
          unitCostMinor: line.unitCostMinor,
          lineNo: line.lineNo,
        }))
      )
      .returning();
    return rows.map(lineToDomain);
  },

  async listLines(ctx: TenantSessionContext, transferId: string): Promise<TransferLineRecord[]> {
    const rows = await ctx.db
      .select()
      .from(stockTransferLines)
      .where(and(eq(stockTransferLines.structureId, ctx.actor.structureId), eq(stockTransferLines.transferId, transferId)))
      .orderBy(asc(stockTransferLines.lineNo));
    return rows.map(lineToDomain);
  },

  async finalizeHeader(
    ctx: TenantSessionContext,
    transferId: string,
    patch: { reference: string; fiscalYear: number; currencyCode: string }
  ): Promise<TransferHeaderRecord> {
    const [row] = await ctx.db
      .update(stockTransfers)
      .set({ reference: patch.reference, fiscalYear: patch.fiscalYear, currencyCode: patch.currencyCode })
      .where(and(eq(stockTransfers.structureId, ctx.actor.structureId), eq(stockTransfers.id, transferId)))
      .returning();
    return headerToDomain(row);
  },

  async list(ctx: TenantSessionContext, filter: ListTransfersFilter): Promise<TransferHeaderRecord[]> {
    const conditions = [eq(stockTransfers.structureId, ctx.actor.structureId)];
    const scopeCondition = storeScopeCondition(filter.storeScope);
    if (scopeCondition) {
      conditions.push(scopeCondition);
    }
    if (filter.status) {
      conditions.push(eq(stockTransfers.status, filter.status));
    }
    const rows = await ctx.db
      .select()
      .from(stockTransfers)
      .where(and(...conditions))
      .orderBy(desc(stockTransfers.createdAt))
      .limit(filter.limit ?? 100);
    return rows.map(headerToDomain);
  },

  async markReceived(
    ctx: TenantSessionContext,
    transferId: string,
    receivedBy: string,
    receivedAt: Date
  ): Promise<TransferHeaderRecord | null> {
    // UPDATE-as-arbiter: `status = 'in_transit'` is part of the WHERE, not
    // a separate read-then-check -- rowCount 0 means it was already
    // received/cancelled by the time this statement ran, even under
    // concurrent callers (Postgres serializes on the row's own lock).
    const rows = await ctx.db
      .update(stockTransfers)
      .set({ status: "received", receivedBy, receivedAt })
      .where(
        and(
          eq(stockTransfers.structureId, ctx.actor.structureId),
          eq(stockTransfers.id, transferId),
          eq(stockTransfers.status, "in_transit")
        )
      )
      .returning();
    return rows[0] ? headerToDomain(rows[0]) : null;
  },

  async markCancelled(
    ctx: TenantSessionContext,
    transferId: string,
    cancelledBy: string,
    cancelledAt: Date,
    cancelReason: string | null
  ): Promise<TransferHeaderRecord | null> {
    const rows = await ctx.db
      .update(stockTransfers)
      .set({ status: "cancelled", cancelledBy, cancelledAt, cancelReason })
      .where(
        and(
          eq(stockTransfers.structureId, ctx.actor.structureId),
          eq(stockTransfers.id, transferId),
          eq(stockTransfers.status, "in_transit")
        )
      )
      .returning();
    return rows[0] ? headerToDomain(rows[0]) : null;
  },

  async sumInTransitQuantityByProduct(
    ctx: TenantSessionContext,
    storeScope: string | null
  ): Promise<Record<string, string>> {
    const storeFilter = storeScope
      ? sql`and (t.from_warehouse_id = ${storeScope} or t.to_warehouse_id = ${storeScope})`
      : sql``;
    const rows = await ctx.db.execute<{ product_id: string; total_quantity: string }>(sql`
      select l.product_id as product_id, sum(l.quantity) as total_quantity
      from stock_transfer_lines l
      join stock_transfers t on t.structure_id = l.structure_id and t.id = l.transfer_id
      where l.structure_id = ${ctx.actor.structureId}
        and t.status = 'in_transit'
        ${storeFilter}
      group by l.product_id
    `);
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.product_id] = row.total_quantity;
    }
    return result;
  },
};
