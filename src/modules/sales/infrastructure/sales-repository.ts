import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { sales, saleLines } from "@/db/schema/sales";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  SalesRepository,
  SaleHeaderRecord,
  SaleLineRecord,
  InsertDraftSaleInput,
  InsertSaleLineInput,
  ConfirmSaleHeaderPatch,
  PaymentProgressDelta,
  ListSalesFilter,
} from "../application/ports";

// Drizzle implementation of the SalesRepository port. This is the ONLY file
// in the sales module allowed to import `@/db/schema/sales` (enforced by
// the ESLint layering rule).

type SaleRow = typeof sales.$inferSelect;
type SaleLineRow = typeof saleLines.$inferSelect;

function headerToDomain(row: SaleRow): SaleHeaderRecord {
  return {
    id: row.id,
    structureId: row.structureId,
    customerId: row.customerId,
    warehouseId: row.warehouseId,
    status: row.status,
    currencyCode: row.currencyCode,
    totalMinor: row.totalMinor,
    subtotalMinor: row.subtotalMinor,
    vatMinor: row.vatMinor,
    discountMinor: row.discountMinor,
    paidMinor: row.paidMinor,
    fiscalYear: row.fiscalYear,
    ticketNumber: row.ticketNumber,
    paymentStatus: row.paymentStatus,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdBy: row.createdBy,
    confirmedAt: row.confirmedAt,
  };
}

function lineToDomain(row: SaleLineRow): SaleLineRecord {
  return {
    id: row.id,
    saleId: row.saleId,
    productId: row.productId,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    currencyCode: row.currencyCode,
    lineTotalMinor: row.lineTotalMinor,
    vatRate: row.vatRate,
    discountMinor: row.discountMinor,
    unitCostMinor: row.unitCostMinor,
    lineNo: row.lineNo,
  };
}

export const salesRepository: SalesRepository = {
  async tryInsertDraft(
    ctx: TenantSessionContext,
    input: InsertDraftSaleInput
  ): Promise<SaleHeaderRecord | null> {
    const rows = await ctx.db
      .insert(sales)
      .values({
        structureId: ctx.actor.structureId,
        customerId: input.customerId,
        warehouseId: input.warehouseId,
        status: "draft",
        currencyCode: input.currencyCode,
        totalMinor: 0n,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        subtotalMinor: 0n,
        vatMinor: 0n,
        discountMinor: 0n,
        paidMinor: 0n,
      })
      // The arbiter: a conflict on this unique index means a replay, full
      // stop -- never pre-SELECT to check first (that would be a race).
      .onConflictDoNothing({ target: [sales.structureId, sales.idempotencyKey] })
      .returning();
    return rows[0] ? headerToDomain(rows[0]) : null;
  },

  async findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<SaleHeaderRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(sales)
      .where(
        and(eq(sales.structureId, ctx.actor.structureId), eq(sales.idempotencyKey, idempotencyKey))
      )
      .limit(1);
    return row ? headerToDomain(row) : null;
  },

  async findById(ctx: TenantSessionContext, saleId: string): Promise<SaleHeaderRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(sales)
      .where(and(eq(sales.structureId, ctx.actor.structureId), eq(sales.id, saleId)))
      .limit(1);
    return row ? headerToDomain(row) : null;
  },

  async findCreatedByForSaleIds(
    ctx: TenantSessionContext,
    saleIds: string[]
  ): Promise<Record<string, string>> {
    if (saleIds.length === 0) {
      return {};
    }
    const rows = await ctx.db
      .select({ id: sales.id, createdBy: sales.createdBy })
      .from(sales)
      .where(and(eq(sales.structureId, ctx.actor.structureId), inArray(sales.id, saleIds)));
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.id] = row.createdBy;
    }
    return result;
  },

  async listSaleIdsCreatedBy(ctx: TenantSessionContext, userId: string): Promise<string[]> {
    const rows = await ctx.db
      .select({ id: sales.id })
      .from(sales)
      .where(and(eq(sales.structureId, ctx.actor.structureId), eq(sales.createdBy, userId)));
    return rows.map((r) => r.id);
  },

  async listOpen(ctx: TenantSessionContext): Promise<SaleHeaderRecord[]> {
    const rows = await ctx.db
      .select()
      .from(sales)
      .where(
        and(
          eq(sales.structureId, ctx.actor.structureId),
          eq(sales.status, "confirmed"),
          inArray(sales.paymentStatus, ["unpaid", "partial"])
        )
      );
    return rows.map(headerToDomain);
  },

  async list(ctx: TenantSessionContext, filter: ListSalesFilter): Promise<SaleHeaderRecord[]> {
    const conditions = [eq(sales.structureId, ctx.actor.structureId)];
    if (filter.createdBy) {
      conditions.push(eq(sales.createdBy, filter.createdBy));
    }
    // multi-store: `storeScope` (the actor's own pinned store, already
    // resolved by resolveStoreScope) ANDs with the optional `warehouseId`
    // narrowing -- both end up as the SAME column, so a gerant's own scope
    // and an unscoped actor's selector never need separate handling here.
    if (filter.storeScope) {
      conditions.push(eq(sales.warehouseId, filter.storeScope));
    } else if (filter.warehouseId) {
      conditions.push(eq(sales.warehouseId, filter.warehouseId));
    }
    if (filter.customerId) {
      conditions.push(eq(sales.customerId, filter.customerId));
    }
    if (filter.status) {
      conditions.push(eq(sales.status, filter.status));
    }
    if (filter.paymentStatus) {
      conditions.push(eq(sales.paymentStatus, filter.paymentStatus));
    }
    if (filter.ticketNumber !== undefined) {
      conditions.push(eq(sales.ticketNumber, filter.ticketNumber));
    }
    if (filter.periodFrom) {
      conditions.push(gte(sales.confirmedAt, filter.periodFrom));
    }
    if (filter.periodTo) {
      conditions.push(lte(sales.confirmedAt, filter.periodTo));
    }

    const rows = await ctx.db
      .select()
      .from(sales)
      .where(and(...conditions))
      .orderBy(desc(sales.confirmedAt))
      .limit(filter.limit ?? 500);
    return rows.map(headerToDomain);
  },

  async listCustomerIdsForStore(ctx: TenantSessionContext, warehouseId: string): Promise<string[]> {
    const rows = await ctx.db
      .selectDistinct({ customerId: sales.customerId })
      .from(sales)
      .where(
        and(
          eq(sales.structureId, ctx.actor.structureId),
          eq(sales.warehouseId, warehouseId),
          isNotNull(sales.customerId)
        )
      );
    return rows.map((r) => r.customerId as string);
  },

  async findWarehouseIdsForSaleIds(
    ctx: TenantSessionContext,
    saleIds: string[]
  ): Promise<Record<string, string>> {
    if (saleIds.length === 0) {
      return {};
    }
    const rows = await ctx.db
      .select({ id: sales.id, warehouseId: sales.warehouseId })
      .from(sales)
      .where(and(eq(sales.structureId, ctx.actor.structureId), inArray(sales.id, saleIds)));
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.id] = row.warehouseId;
    }
    return result;
  },

  async listLines(ctx: TenantSessionContext, saleId: string): Promise<SaleLineRecord[]> {
    const rows = await ctx.db
      .select()
      .from(saleLines)
      .where(and(eq(saleLines.structureId, ctx.actor.structureId), eq(saleLines.saleId, saleId)))
      .orderBy(asc(saleLines.lineNo));
    return rows.map(lineToDomain);
  },

  async insertLines(
    ctx: TenantSessionContext,
    saleId: string,
    lines: InsertSaleLineInput[]
  ): Promise<SaleLineRecord[]> {
    if (lines.length === 0) {
      return [];
    }
    const rows = await ctx.db
      .insert(saleLines)
      .values(
        lines.map((line) => ({
          structureId: ctx.actor.structureId,
          saleId,
          productId: line.productId,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          currencyCode: line.currencyCode,
          lineTotalMinor: line.lineTotalMinor,
          vatRate: line.vatRate,
          discountMinor: line.discountMinor,
          unitCostMinor: line.unitCostMinor,
          lineNo: line.lineNo,
        }))
      )
      .returning();
    return rows.map(lineToDomain);
  },

  async confirmHeader(
    ctx: TenantSessionContext,
    saleId: string,
    patch: ConfirmSaleHeaderPatch
  ): Promise<SaleHeaderRecord> {
    const [row] = await ctx.db
      .update(sales)
      .set({
        status: "confirmed",
        ticketNumber: patch.ticketNumber,
        fiscalYear: patch.fiscalYear,
        subtotalMinor: patch.subtotalMinor,
        vatMinor: patch.vatMinor,
        discountMinor: patch.discountMinor,
        totalMinor: patch.totalMinor,
        paidMinor: patch.paidMinor,
        paymentStatus: patch.paymentStatus,
        confirmedAt: patch.confirmedAt,
      })
      .where(and(eq(sales.structureId, ctx.actor.structureId), eq(sales.id, saleId)))
      .returning();
    return headerToDomain(row);
  },

  async updatePaymentProgress(
    ctx: TenantSessionContext,
    saleId: string,
    delta: PaymentProgressDelta
  ): Promise<SaleHeaderRecord | null> {
    // C1 fix: the increment AND the bounds check happen against the
    // row's CURRENT value, in the same statement, under the row lock
    // Postgres takes for the UPDATE itself -- two concurrent calls for
    // the same sale serialize here instead of one clobbering the other's
    // read. `rowCount = 0` (empty `rows`) means the bounds check failed
    // (would go negative or over total) OR the row doesn't exist; the
    // application layer is responsible for telling those apart (it
    // already confirmed existence before calling this).
    const rows = await ctx.db
      .update(sales)
      .set({
        paidMinor: sql`${sales.paidMinor} + ${delta.deltaMinor}`,
        paymentStatus: sql`(case
          when ${sales.paidMinor} + ${delta.deltaMinor} = 0 then 'unpaid'
          when ${sales.paidMinor} + ${delta.deltaMinor} = ${sales.totalMinor} then 'paid'
          else 'partial'
        end)::sale_payment_status`,
      })
      .where(
        and(
          eq(sales.structureId, ctx.actor.structureId),
          eq(sales.id, saleId),
          sql`${sales.paidMinor} + ${delta.deltaMinor} between 0 and ${sales.totalMinor}`
        )
      )
      .returning();
    return rows[0] ? headerToDomain(rows[0]) : null;
  },
};
