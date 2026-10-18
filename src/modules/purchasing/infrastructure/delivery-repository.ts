import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { supplierDeliveries, supplierDeliveryLines } from "@/db/schema/purchasing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "@/modules/inventory";
import type {
  DeliveryRepository,
  DeliveryRecord,
  DeliveryLineRecord,
  InsertDeliveryDraftInput,
  InsertDeliveryLineInput,
  FinalizeDeliveryHeaderInput,
  ListDeliveriesFilter,
} from "../application/ports";

type DeliveryRow = typeof supplierDeliveries.$inferSelect;
type DeliveryLineRow = typeof supplierDeliveryLines.$inferSelect;

function toDomain(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    supplierId: row.supplierId,
    warehouseId: row.warehouseId,
    reference: row.reference,
    fiscalYear: row.fiscalYear,
    currencyCode: row.currencyCode,
    totalMinor: row.totalMinor,
    paidMinor: row.paidMinor,
    paymentStatus: row.paymentStatus,
    dueAt: row.dueAt,
    receivedAt: row.receivedAt,
    createdBy: row.createdBy,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    cancelledAt: row.cancelledAt,
  };
}

function lineToDomain(row: DeliveryLineRow): DeliveryLineRecord {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    productId: row.productId,
    quantity: Quantity.fromString(row.quantity),
    unitCostMinor: row.unitCostMinor,
    lineTotalMinor: row.lineTotalMinor,
    lineNo: row.lineNo,
  };
}

export const deliveryRepository: DeliveryRepository = {
  async tryInsertDraft(
    ctx: TenantSessionContext,
    input: InsertDeliveryDraftInput
  ): Promise<DeliveryRecord | null> {
    const rows = await ctx.db
      .insert(supplierDeliveries)
      .values({
        structureId: ctx.actor.structureId,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        // Placeholder -- finalizeHeader overwrites both, still inside this
        // SAME uncommitted transaction, before anything is returned. Keyed
        // off the idempotency key's own uniqueness, same pattern as
        // stock-transfers' createTransfer draft.
        reference: `pending:${input.idempotencyKey}`,
        fiscalYear: 0,
        currencyCode: input.currencyCode,
        totalMinor: 0n,
        paidMinor: 0n,
        paymentStatus: "unpaid",
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      })
      .onConflictDoNothing({
        target: [supplierDeliveries.structureId, supplierDeliveries.idempotencyKey],
      })
      .returning();
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<DeliveryRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(supplierDeliveries)
      .where(
        and(
          eq(supplierDeliveries.structureId, ctx.actor.structureId),
          eq(supplierDeliveries.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async findById(ctx: TenantSessionContext, deliveryId: string): Promise<DeliveryRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(supplierDeliveries)
      .where(
        and(eq(supplierDeliveries.structureId, ctx.actor.structureId), eq(supplierDeliveries.id, deliveryId))
      )
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async insertLines(
    ctx: TenantSessionContext,
    deliveryId: string,
    lines: InsertDeliveryLineInput[]
  ): Promise<DeliveryLineRecord[]> {
    if (lines.length === 0) return [];
    const rows = await ctx.db
      .insert(supplierDeliveryLines)
      .values(
        lines.map((line) => ({
          structureId: ctx.actor.structureId,
          deliveryId,
          productId: line.productId,
          quantity: line.quantity.toDbString(),
          unitCostMinor: line.unitCostMinor,
          lineTotalMinor: line.lineTotalMinor,
          lineNo: line.lineNo,
        }))
      )
      .returning();
    return rows.map(lineToDomain);
  },

  async listLines(ctx: TenantSessionContext, deliveryId: string): Promise<DeliveryLineRecord[]> {
    const rows = await ctx.db
      .select()
      .from(supplierDeliveryLines)
      .where(
        and(
          eq(supplierDeliveryLines.structureId, ctx.actor.structureId),
          eq(supplierDeliveryLines.deliveryId, deliveryId)
        )
      )
      .orderBy(supplierDeliveryLines.lineNo);
    return rows.map(lineToDomain);
  },

  async finalizeHeader(
    ctx: TenantSessionContext,
    deliveryId: string,
    input: FinalizeDeliveryHeaderInput
  ): Promise<DeliveryRecord> {
    const [row] = await ctx.db
      .update(supplierDeliveries)
      .set({
        reference: input.reference,
        fiscalYear: input.fiscalYear,
        totalMinor: input.totalMinor,
        paymentStatus: input.paymentStatus,
        receivedAt: input.receivedAt,
        dueAt: input.dueAt,
      })
      .where(
        and(eq(supplierDeliveries.structureId, ctx.actor.structureId), eq(supplierDeliveries.id, deliveryId))
      )
      .returning();
    return toDomain(row);
  },

  async list(ctx: TenantSessionContext, filter: ListDeliveriesFilter): Promise<DeliveryRecord[]> {
    const conditions = [eq(supplierDeliveries.structureId, ctx.actor.structureId)];
    if (filter.supplierId) {
      conditions.push(eq(supplierDeliveries.supplierId, filter.supplierId));
    }
    // multi-store ceiling -- app-layer re-check on top of RLS's floor (same
    // discipline as every other store-scoped list in this codebase).
    if (filter.storeScope !== null) {
      conditions.push(eq(supplierDeliveries.warehouseId, filter.storeScope));
    }
    const rows = await ctx.db
      .select()
      .from(supplierDeliveries)
      .where(and(...conditions))
      .orderBy(sql`${supplierDeliveries.receivedAt} desc`);
    return rows.map(toDomain);
  },

  async sumDebtBySupplier(ctx: TenantSessionContext, supplierId: string): Promise<bigint> {
    const [row] = await ctx.db
      .select({
        debt: sql<string>`coalesce(sum(${supplierDeliveries.totalMinor} - ${supplierDeliveries.paidMinor}), 0)`,
      })
      .from(supplierDeliveries)
      .where(
        and(
          eq(supplierDeliveries.structureId, ctx.actor.structureId),
          eq(supplierDeliveries.supplierId, supplierId),
          isNull(supplierDeliveries.cancelledAt)
        )
      );
    return BigInt(row?.debt ?? "0");
  },

  async sumDeliveredQuantitySince(
    ctx: TenantSessionContext,
    supplierId: string,
    sinceExclusive: Date
  ): Promise<Quantity> {
    const [row] = await ctx.db
      .select({
        total: sql<string>`coalesce(sum(${supplierDeliveryLines.quantity}), 0)`,
      })
      .from(supplierDeliveryLines)
      .innerJoin(
        supplierDeliveries,
        and(
          eq(supplierDeliveryLines.structureId, supplierDeliveries.structureId),
          eq(supplierDeliveryLines.deliveryId, supplierDeliveries.id)
        )
      )
      .where(
        and(
          eq(supplierDeliveries.structureId, ctx.actor.structureId),
          eq(supplierDeliveries.supplierId, supplierId),
          isNull(supplierDeliveries.cancelledAt),
          gt(supplierDeliveries.receivedAt, sinceExclusive)
        )
      );
    return Quantity.fromString(row?.total ?? "0");
  },
};
