import { and, eq, inArray, sql } from "drizzle-orm";
import { payments, paymentAllocations } from "@/db/schema/billing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  InsertSalePaymentInput,
  InsertStandalonePaymentInput,
  AllocationInput,
  AllocationRecord,
  PaymentRecord,
  PaymentFullRecord,
  PaymentRepository,
  ListPaymentsFilter,
} from "../application/ports";

type PaymentRow = typeof payments.$inferSelect;

function toFullRecord(row: PaymentRow): PaymentFullRecord {
  return {
    id: row.id,
    saleId: row.saleId,
    customerId: row.customerId,
    warehouseId: row.warehouseId,
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    method: row.method,
    receivedAt: row.receivedAt,
    reference: row.reference,
    voidedAt: row.voidedAt,
    createdBy: row.createdBy,
  };
}

export const paymentRepository: PaymentRepository = {
  async insertForSale(
    ctx: TenantSessionContext,
    input: InsertSalePaymentInput
  ): Promise<PaymentRecord> {
    const [row] = await ctx.db
      .insert(payments)
      .values({
        structureId: ctx.actor.structureId,
        customerId: input.customerId,
        saleId: input.saleId,
        warehouseId: input.warehouseId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        method: input.method,
        idempotencyKey: input.idempotencyKey,
        reference: input.reference ?? null,
        createdBy: ctx.actor.userId,
        receivedAt: input.receivedAt,
      })
      .returning();
    return { id: row.id, amountMinor: row.amountMinor };
  },

  async tryInsertStandalone(
    ctx: TenantSessionContext,
    input: InsertStandalonePaymentInput
  ): Promise<PaymentFullRecord | null> {
    const rows = await ctx.db
      .insert(payments)
      .values({
        structureId: ctx.actor.structureId,
        customerId: input.customerId,
        saleId: input.saleId,
        warehouseId: input.warehouseId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        method: input.method,
        idempotencyKey: input.idempotencyKey,
        reference: input.reference ?? null,
        createdBy: input.createdBy,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing({ target: [payments.structureId, payments.idempotencyKey] })
      .returning();
    return rows[0] ? toFullRecord(rows[0]) : null;
  },

  async findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<PaymentFullRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(payments)
      .where(
        and(eq(payments.structureId, ctx.actor.structureId), eq(payments.idempotencyKey, idempotencyKey))
      )
      .limit(1);
    return row ? toFullRecord(row) : null;
  },

  async findById(ctx: TenantSessionContext, paymentId: string): Promise<PaymentFullRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(payments)
      .where(and(eq(payments.structureId, ctx.actor.structureId), eq(payments.id, paymentId)))
      .limit(1);
    return row ? toFullRecord(row) : null;
  },

  async list(ctx: TenantSessionContext, filter: ListPaymentsFilter): Promise<PaymentFullRecord[]> {
    const conditions = [eq(payments.structureId, ctx.actor.structureId)];
    if (filter.createdBy) {
      conditions.push(eq(payments.createdBy, filter.createdBy));
    }
    if (filter.saleIds) {
      // L-b fix -- see invoice-repository.ts's identical comment.
      conditions.push(inArray(payments.saleId, filter.saleIds));
    }
    // multi-store: app-layer ceiling on top of RLS's floor -- explicit, not
    // just relying on the RLS predicate, so a store-scoped actor's listing
    // is provably filtered here too (defense in depth, same discipline as
    // every other required `scope`/`storeScope` parameter in this codebase).
    if (filter.storeScope !== null) {
      conditions.push(eq(payments.warehouseId, filter.storeScope));
    }
    const rows = await ctx.db
      .select()
      .from(payments)
      .where(and(...conditions));
    return rows.map(toFullRecord);
  },

  async markVoided(
    ctx: TenantSessionContext,
    paymentId: string,
    voidedAt: Date
  ): Promise<PaymentFullRecord | null> {
    // C1 fix: conditional on `voided_at IS NULL` in the SAME statement --
    // two concurrent voidPayment calls for the same payment can no
    // longer both succeed and both debit the sale/invoice; the second one
    // gets rowCount = 0 here and the application layer turns that into
    // PaymentAlreadyVoidedError.
    const rows = await ctx.db
      .update(payments)
      .set({ voidedAt })
      .where(
        and(
          eq(payments.structureId, ctx.actor.structureId),
          eq(payments.id, paymentId),
          sql`${payments.voidedAt} is null`
        )
      )
      .returning();
    return rows[0] ? toFullRecord(rows[0]) : null;
  },

  async insertAllocation(ctx: TenantSessionContext, input: AllocationInput): Promise<void> {
    await ctx.db.insert(paymentAllocations).values({
      structureId: ctx.actor.structureId,
      paymentId: input.paymentId,
      invoiceId: input.invoiceId,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
    });
  },

  async findAllocationByPaymentId(
    ctx: TenantSessionContext,
    paymentId: string
  ): Promise<AllocationRecord | null> {
    const [row] = await ctx.db
      .select({ invoiceId: paymentAllocations.invoiceId, amountMinor: paymentAllocations.amountMinor })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.structureId, ctx.actor.structureId),
          eq(paymentAllocations.paymentId, paymentId)
        )
      )
      .limit(1);
    return row ?? null;
  },
};
