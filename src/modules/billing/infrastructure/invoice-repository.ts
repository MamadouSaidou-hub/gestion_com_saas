import { and, eq, inArray, sql } from "drizzle-orm";
import { invoices } from "@/db/schema/billing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  InvoiceRepository,
  InvoiceRecord,
  InsertInvoiceInput,
  InvoicePaymentProgressDelta,
  ListInvoicesFilter,
  OutstandingSummary,
} from "../application/ports";

type InvoiceRow = typeof invoices.$inferSelect;

function toDomain(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    saleId: row.saleId,
    customerId: row.customerId,
    docNumber: row.docNumber,
    fiscalYear: row.fiscalYear,
    currencyCode: row.currencyCode,
    totalMinor: row.totalMinor,
    paidMinor: row.paidMinor,
    status: row.status,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    createdBy: row.createdBy,
  };
}

const OPEN_STATUSES = ["issued", "partially_paid"] as const;

export const invoiceRepository: InvoiceRepository = {
  async tryInsertForSale(
    ctx: TenantSessionContext,
    input: InsertInvoiceInput
  ): Promise<InvoiceRecord | null> {
    const rows = await ctx.db
      .insert(invoices)
      .values({
        structureId: ctx.actor.structureId,
        saleId: input.saleId,
        customerId: input.customerId,
        docNumber: input.docNumber,
        fiscalYear: input.fiscalYear,
        currencyCode: input.currencyCode,
        totalMinor: input.totalMinor,
        paidMinor: input.paidMinor,
        status: input.status,
        issuedAt: input.issuedAt,
        createdBy: input.createdBy,
      })
      // Matches migration 0011's partial unique index exactly -- the
      // arbiter for "ask twice for the same sale, get the same invoice".
      .onConflictDoNothing({
        target: [invoices.structureId, invoices.saleId],
        where: sql`${invoices.saleId} is not null`,
      })
      .returning();
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async findBySaleId(ctx: TenantSessionContext, saleId: string): Promise<InvoiceRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.structureId, ctx.actor.structureId), eq(invoices.saleId, saleId)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async findById(ctx: TenantSessionContext, invoiceId: string): Promise<InvoiceRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.structureId, ctx.actor.structureId), eq(invoices.id, invoiceId)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async list(ctx: TenantSessionContext, filter: ListInvoicesFilter): Promise<InvoiceRecord[]> {
    const conditions = [eq(invoices.structureId, ctx.actor.structureId)];
    if (filter.createdBy) {
      conditions.push(eq(invoices.createdBy, filter.createdBy));
    }
    if (filter.status) {
      conditions.push(eq(invoices.status, filter.status));
    }
    if (filter.saleIds) {
      // L-b fix: pushes the 'own' scope filter into SQL -- an empty array
      // means "no sales owned by this actor", which must return zero
      // rows, not every row (inArray with an empty list is always false
      // in Postgres, which is exactly the wanted behaviour here).
      conditions.push(inArray(invoices.saleId, filter.saleIds));
    }
    const rows = await ctx.db
      .select()
      .from(invoices)
      .where(and(...conditions));
    return rows.map(toDomain);
  },

  async updatePaymentProgress(
    ctx: TenantSessionContext,
    invoiceId: string,
    delta: InvoicePaymentProgressDelta
  ): Promise<InvoiceRecord | null> {
    // C1 fix: same atomic increment + bounds-check pattern as
    // sales-repository.ts's updatePaymentProgress -- see that file's
    // comment for why this is what prevents a lost update between two
    // concurrent payments/voids against the same invoice.
    const rows = await ctx.db
      .update(invoices)
      .set({
        paidMinor: sql`${invoices.paidMinor} + ${delta.deltaMinor}`,
        status: sql`(case
          when ${invoices.paidMinor} + ${delta.deltaMinor} = 0 then 'issued'
          when ${invoices.paidMinor} + ${delta.deltaMinor} = ${invoices.totalMinor} then 'paid'
          else 'partially_paid'
        end)::invoice_status`,
      })
      .where(
        and(
          eq(invoices.structureId, ctx.actor.structureId),
          eq(invoices.id, invoiceId),
          sql`${invoices.paidMinor} + ${delta.deltaMinor} between 0 and ${invoices.totalMinor}`
        )
      )
      .returning();
    return rows[0] ? toDomain(rows[0]) : null;
  },

  async listSaleIdsWithInvoice(ctx: TenantSessionContext): Promise<string[]> {
    const rows = await ctx.db
      .select({ saleId: invoices.saleId })
      .from(invoices)
      .where(
        and(eq(invoices.structureId, ctx.actor.structureId), sql`${invoices.saleId} is not null`)
      );
    return rows.map((r) => r.saleId as string);
  },

  async sumOutstanding(ctx: TenantSessionContext): Promise<OutstandingSummary> {
    const rows = await ctx.db
      .select({
        totalMinor: invoices.totalMinor,
        paidMinor: invoices.paidMinor,
        dueAt: invoices.dueAt,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.structureId, ctx.actor.structureId),
          inArray(invoices.status, [...OPEN_STATUSES])
        )
      );

    const now = new Date();
    let totalMinor = 0n;
    let overdueMinor = 0n;
    for (const row of rows) {
      const balance = row.totalMinor - row.paidMinor;
      totalMinor += balance;
      if (row.dueAt && row.dueAt < now) {
        overdueMinor += balance;
      }
    }
    return { totalMinor, overdueMinor };
  },
};
