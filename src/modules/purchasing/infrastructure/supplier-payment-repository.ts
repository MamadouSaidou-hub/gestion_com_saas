import { and, eq, sql } from "drizzle-orm";
import { supplierPayments, supplierPaymentAllocations } from "@/db/schema/purchasing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  SupplierPaymentRepository,
  SupplierPaymentRecord,
  InsertSupplierPaymentInput,
  SupplierPaymentAllocationInput,
} from "../application/ports";

type SupplierPaymentRow = typeof supplierPayments.$inferSelect;

function toDomain(row: SupplierPaymentRow): SupplierPaymentRecord {
  return {
    id: row.id,
    supplierId: row.supplierId,
    deliveryId: row.deliveryId,
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    method: row.method,
    reference: row.reference,
    paidAt: row.paidAt,
    createdBy: row.createdBy,
    idempotencyKey: row.idempotencyKey,
    voidedAt: row.voidedAt,
  };
}

export const supplierPaymentRepository: SupplierPaymentRepository = {
  async tryInsert(
    ctx: TenantSessionContext,
    input: InsertSupplierPaymentInput
  ): Promise<SupplierPaymentRecord | null> {
    const rows = await ctx.db
      .insert(supplierPayments)
      .values({
        structureId: ctx.actor.structureId,
        supplierId: input.supplierId,
        deliveryId: input.deliveryId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        method: input.method,
        reference: input.reference ?? null,
        paidAt: input.paidAt,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({
        target: [supplierPayments.structureId, supplierPayments.idempotencyKey],
      })
      .returning();
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<SupplierPaymentRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.structureId, ctx.actor.structureId),
          eq(supplierPayments.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async findById(ctx: TenantSessionContext, paymentId: string): Promise<SupplierPaymentRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(supplierPayments)
      .where(and(eq(supplierPayments.structureId, ctx.actor.structureId), eq(supplierPayments.id, paymentId)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async markVoided(
    ctx: TenantSessionContext,
    paymentId: string,
    voidedAt: Date
  ): Promise<SupplierPaymentRecord | null> {
    // C1 fix: conditional on `voided_at IS NULL` in the SAME statement --
    // the arbiter, mirrors billing's payment-repository.ts markVoided
    // exactly.
    const rows = await ctx.db
      .update(supplierPayments)
      .set({ voidedAt })
      .where(
        and(
          eq(supplierPayments.structureId, ctx.actor.structureId),
          eq(supplierPayments.id, paymentId),
          sql`${supplierPayments.voidedAt} is null`
        )
      )
      .returning();
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async insertAllocation(ctx: TenantSessionContext, input: SupplierPaymentAllocationInput): Promise<void> {
    await ctx.db.insert(supplierPaymentAllocations).values({
      structureId: ctx.actor.structureId,
      supplierPaymentId: input.supplierPaymentId,
      deliveryId: input.deliveryId,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
    });
  },

  async findAllocationByPaymentId(
    ctx: TenantSessionContext,
    paymentId: string
  ): Promise<{ deliveryId: string; amountMinor: bigint } | null> {
    const [row] = await ctx.db
      .select({
        deliveryId: supplierPaymentAllocations.deliveryId,
        amountMinor: supplierPaymentAllocations.amountMinor,
      })
      .from(supplierPaymentAllocations)
      .where(
        and(
          eq(supplierPaymentAllocations.structureId, ctx.actor.structureId),
          eq(supplierPaymentAllocations.supplierPaymentId, paymentId)
        )
      )
      .limit(1);
    return row ?? null;
  },
};
