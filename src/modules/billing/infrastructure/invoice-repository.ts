import { and, eq, inArray, sql } from "drizzle-orm";
import { invoices } from "@/db/schema/billing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { applyAtomicBoundedDelta } from "@/platform/money/atomic-delta";
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

// `applyAtomicBoundedDelta` goes through `ctx.db.execute(sql\`...\`)`
// ("returning *"), which -- unlike drizzle's own query builder -- returns
// the DRIVER's raw column names (snake_case), not drizzle's camelCase
// mapping. This small shape + mapper is the one place that translates back,
// kept local to this repository (the generic primitive itself stays
// table-agnostic).
interface RawInvoiceRow {
  id: string;
  sale_id: string | null;
  customer_id: string | null;
  doc_number: string;
  fiscal_year: number;
  currency_code: string;
  total_minor: bigint;
  paid_minor: bigint;
  status: InvoiceRow["status"];
  issued_at: Date | null;
  due_at: Date | null;
  created_by: string;
}

function toDomainFromRaw(row: RawInvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    saleId: row.sale_id,
    customerId: row.customer_id,
    docNumber: row.doc_number,
    fiscalYear: row.fiscal_year,
    currencyCode: row.currency_code,
    totalMinor: row.total_minor,
    paidMinor: row.paid_minor,
    status: row.status,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    createdBy: row.created_by,
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
    // C1 fix, now on the SHARED primitive (src/platform/money/atomic-delta.ts)
    // -- same atomic increment + bounds-check pattern purchasing's
    // supplier_deliveries.paid_minor runs through, so the two sides
    // provably share the fix instead of carrying two independently
    // drifting copies of it.
    const row = await applyAtomicBoundedDelta<RawInvoiceRow>(ctx, {
      table: "invoices",
      id: invoiceId,
      deltaColumn: "paid_minor",
      deltaMinor: delta.deltaMinor,
      ceilingColumn: "total_minor",
      extraSet: {
        status: sql`(case
          when paid_minor + ${delta.deltaMinor} = 0 then 'issued'
          when paid_minor + ${delta.deltaMinor} = total_minor then 'paid'
          else 'partially_paid'
        end)::invoice_status`,
      },
    });
    return row ? toDomainFromRaw(row) : null;
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

  // Same predicate as sumOutstanding below (status in OPEN_STATUSES) --
  // granular rows instead of the aggregate, so getReceivablesByCustomer can
  // group by customerId without recomputing what "outstanding" means.
  async listOutstanding(ctx: TenantSessionContext): Promise<InvoiceRecord[]> {
    const rows = await ctx.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.structureId, ctx.actor.structureId),
          inArray(invoices.status, [...OPEN_STATUSES])
        )
      );
    return rows.map(toDomain);
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
