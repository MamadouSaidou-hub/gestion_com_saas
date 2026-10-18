import { and, desc, eq, sql } from "drizzle-orm";
import { stockCounts, stockCountLines } from "@/db/schema/stock-transfers";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "@/modules/inventory";
import type {
  StockCountsRepository,
  StockCountHeaderRecord,
  StockCountLineRecord,
  InsertDraftStockCountInput,
  InsertStockCountLineInput,
  StockCountLineResultPatch,
  ListStockCountsFilter,
  ListVarianceLinesFilter,
  VarianceLineRow,
} from "../application/ports";

// Drizzle implementation -- the ONLY file in this module allowed to import
// `@/db/schema/stock-transfers` for the STOCK COUNT tables (enforced by the
// ESLint layering rule). Lives alongside transfers-repository.ts since
// both tables are defined in the SAME schema file (migration 0014).

type StockCountRow = typeof stockCounts.$inferSelect;
type StockCountLineRow = typeof stockCountLines.$inferSelect;

function headerToDomain(row: StockCountRow): StockCountHeaderRecord {
  return {
    id: row.id,
    structureId: row.structureId,
    warehouseId: row.warehouseId,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    validatedBy: row.validatedBy,
    validatedAt: row.validatedAt,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt,
    idempotencyKey: row.idempotencyKey,
  };
}

function lineToDomain(row: StockCountLineRow): StockCountLineRecord {
  return {
    id: row.id,
    stockCountId: row.stockCountId,
    productId: row.productId,
    theoreticalQty: Quantity.fromString(row.theoreticalQty),
    countedQty: row.countedQty !== null ? Quantity.fromString(row.countedQty) : null,
    varianceQty: row.varianceQty !== null ? Quantity.fromString(row.varianceQty) : null,
    unitCostMinor: row.unitCostMinor,
    varianceValueMinor: row.varianceValueMinor,
  };
}

export const stockCountsRepository: StockCountsRepository = {
  async tryInsertDraft(
    ctx: TenantSessionContext,
    input: InsertDraftStockCountInput
  ): Promise<StockCountHeaderRecord | null> {
    const rows = await ctx.db
      .insert(stockCounts)
      .values({
        structureId: ctx.actor.structureId,
        warehouseId: input.warehouseId,
        status: "draft",
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: [stockCounts.structureId, stockCounts.idempotencyKey] })
      .returning();
    return rows[0] ? headerToDomain(rows[0]) : null;
  },

  async findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<StockCountHeaderRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.structureId, ctx.actor.structureId), eq(stockCounts.idempotencyKey, idempotencyKey)))
      .limit(1);
    return row ? headerToDomain(row) : null;
  },

  async findById(ctx: TenantSessionContext, stockCountId: string): Promise<StockCountHeaderRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.structureId, ctx.actor.structureId), eq(stockCounts.id, stockCountId)))
      .limit(1);
    return row ? headerToDomain(row) : null;
  },

  async insertLines(
    ctx: TenantSessionContext,
    stockCountId: string,
    lines: InsertStockCountLineInput[]
  ): Promise<StockCountLineRecord[]> {
    if (lines.length === 0) {
      return [];
    }
    const rows = await ctx.db
      .insert(stockCountLines)
      .values(
        lines.map((line) => ({
          structureId: ctx.actor.structureId,
          stockCountId,
          productId: line.productId,
          theoreticalQty: line.theoreticalQty.toDbString(),
        }))
      )
      .returning();
    return rows.map(lineToDomain);
  },

  async listLines(ctx: TenantSessionContext, stockCountId: string): Promise<StockCountLineRecord[]> {
    const rows = await ctx.db
      .select()
      .from(stockCountLines)
      .where(and(eq(stockCountLines.structureId, ctx.actor.structureId), eq(stockCountLines.stockCountId, stockCountId)));
    return rows.map(lineToDomain);
  },

  async list(ctx: TenantSessionContext, filter: ListStockCountsFilter): Promise<StockCountHeaderRecord[]> {
    const conditions = [eq(stockCounts.structureId, ctx.actor.structureId)];
    if (filter.storeScope !== null) {
      conditions.push(eq(stockCounts.warehouseId, filter.storeScope));
    }
    if (filter.status) {
      conditions.push(eq(stockCounts.status, filter.status));
    }
    const rows = await ctx.db
      .select()
      .from(stockCounts)
      .where(and(...conditions))
      .orderBy(desc(stockCounts.createdAt))
      .limit(filter.limit ?? 100);
    return rows.map(headerToDomain);
  },

  async markValidated(
    ctx: TenantSessionContext,
    stockCountId: string,
    validatedBy: string,
    validatedAt: Date
  ): Promise<StockCountHeaderRecord | null> {
    const rows = await ctx.db
      .update(stockCounts)
      .set({ status: "validated", validatedBy, validatedAt })
      .where(
        and(
          eq(stockCounts.structureId, ctx.actor.structureId),
          eq(stockCounts.id, stockCountId),
          eq(stockCounts.status, "draft")
        )
      )
      .returning();
    return rows[0] ? headerToDomain(rows[0]) : null;
  },

  async patchLineResults(
    ctx: TenantSessionContext,
    stockCountId: string,
    patches: StockCountLineResultPatch[]
  ): Promise<void> {
    for (const patch of patches) {
      await ctx.db
        .update(stockCountLines)
        .set({
          countedQty: patch.countedQty.toDbString(),
          varianceQty: patch.varianceQty.toDbString(),
          unitCostMinor: patch.unitCostMinor,
          varianceValueMinor: patch.varianceValueMinor,
        })
        .where(
          and(
            eq(stockCountLines.structureId, ctx.actor.structureId),
            eq(stockCountLines.stockCountId, stockCountId),
            eq(stockCountLines.productId, patch.productId)
          )
        );
    }
  },

  async listVarianceLines(
    ctx: TenantSessionContext,
    filter: ListVarianceLinesFilter
  ): Promise<VarianceLineRow[]> {
    const storeFilter = filter.storeScope ? sql`and c.warehouse_id = ${filter.storeScope}` : sql``;
    const rows = await ctx.db.execute<{
      stock_count_id: string;
      warehouse_id: string;
      product_id: string;
      theoretical_qty: string;
      counted_qty: string;
      variance_qty: string;
      unit_cost_minor: string;
      variance_value_minor: string;
      validated_at: Date;
    }>(sql`
      select
        l.stock_count_id as stock_count_id,
        c.warehouse_id as warehouse_id,
        l.product_id as product_id,
        l.theoretical_qty as theoretical_qty,
        l.counted_qty as counted_qty,
        l.variance_qty as variance_qty,
        l.unit_cost_minor as unit_cost_minor,
        l.variance_value_minor as variance_value_minor,
        c.validated_at as validated_at
      from stock_count_lines l
      join stock_counts c on c.structure_id = l.structure_id and c.id = l.stock_count_id
      where l.structure_id = ${ctx.actor.structureId}
        and c.status = 'validated'
        and l.variance_qty is not null
        and l.variance_qty <> 0
        ${storeFilter}
      order by c.validated_at desc
      limit ${filter.limit ?? 100}
    `);
    return rows.map((row) => ({
      stockCountId: row.stock_count_id,
      warehouseId: row.warehouse_id,
      productId: row.product_id,
      theoreticalQty: Quantity.fromString(row.theoretical_qty),
      countedQty: Quantity.fromString(row.counted_qty),
      varianceQty: Quantity.fromString(row.variance_qty),
      unitCostMinor: BigInt(row.unit_cost_minor),
      varianceValueMinor: BigInt(row.variance_value_minor),
      validatedAt: new Date(row.validated_at),
    }));
  },
};
