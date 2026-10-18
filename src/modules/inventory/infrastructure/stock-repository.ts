import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { stockLevels, stockMovements } from "@/db/schema/inventory";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { Quantity } from "../domain/quantity";
import type {
  StockRepository,
  StockLevelRecord,
  StockMovementRecord,
  InsertMovementInput,
  UpsertLevelInput,
  ListMovementsFilter,
  ListLevelsFilter,
  ProductWarehousePair,
} from "../application/ports";

// Drizzle implementation of the StockRepository port. This is the ONLY file
// in the inventory module allowed to import `@/db/schema/inventory`
// (enforced by the ESLint layering rule) -- domain/application/api/index
// never see a drizzle row shape, only `StockLevelRecord`/`StockMovementRecord`
// (which already carry a `Quantity` value object, never a raw string).

type StockLevelRow = typeof stockLevels.$inferSelect;
type StockMovementRow = typeof stockMovements.$inferSelect;

function levelToDomain(row: StockLevelRow): StockLevelRecord {
  return {
    structureId: row.structureId,
    productId: row.productId,
    warehouseId: row.warehouseId,
    quantity: Quantity.fromString(row.quantity),
    avgCostMinor: row.avgCostMinor,
    currencyCode: row.currencyCode,
    updatedAt: row.updatedAt,
  };
}

function movementToDomain(row: StockMovementRow): StockMovementRecord {
  return {
    id: row.id,
    structureId: row.structureId,
    productId: row.productId,
    warehouseId: row.warehouseId,
    direction: row.direction,
    quantity: Quantity.fromString(row.quantity),
    unitCostMinor: row.unitCostMinor,
    currencyCode: row.currencyCode,
    reason: row.reason,
    saleId: row.saleId,
    occurredAt: row.occurredAt,
    createdBy: row.createdBy,
  };
}

export const stockRepository: StockRepository = {
  async lockLevelsForUpdate(
    ctx: TenantSessionContext,
    warehouseId: string,
    productIds: string[]
  ): Promise<StockLevelRecord[]> {
    if (productIds.length === 0) {
      return [];
    }
    // Ordered by productId ASC -- the deadlock-avoidance discipline two
    // concurrent sales confirming against overlapping product sets depend
    // on (see applyStockOut's header comment / confirmSale, step 3).
    const rows = await ctx.db
      .select()
      .from(stockLevels)
      .where(
        and(
          eq(stockLevels.structureId, ctx.actor.structureId),
          eq(stockLevels.warehouseId, warehouseId),
          inArray(stockLevels.productId, productIds)
        )
      )
      .orderBy(asc(stockLevels.productId))
      .for("update");
    return rows.map(levelToDomain);
  },

  async getLevel(
    ctx: TenantSessionContext,
    productId: string,
    warehouseId: string
  ): Promise<StockLevelRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(stockLevels)
      .where(
        and(
          eq(stockLevels.structureId, ctx.actor.structureId),
          eq(stockLevels.productId, productId),
          eq(stockLevels.warehouseId, warehouseId)
        )
      )
      .limit(1);
    return row ? levelToDomain(row) : null;
  },

  async listLevels(
    ctx: TenantSessionContext,
    filter: ListLevelsFilter
  ): Promise<StockLevelRecord[]> {
    const conditions = [eq(stockLevels.structureId, ctx.actor.structureId)];
    if (filter.warehouseId) {
      conditions.push(eq(stockLevels.warehouseId, filter.warehouseId));
    }
    if (filter.productIds && filter.productIds.length > 0) {
      conditions.push(inArray(stockLevels.productId, filter.productIds));
    }
    const rows = await ctx.db
      .select()
      .from(stockLevels)
      .where(and(...conditions));
    return rows.map(levelToDomain);
  },

  async upsertLevel(ctx: TenantSessionContext, input: UpsertLevelInput): Promise<void> {
    await ctx.db
      .insert(stockLevels)
      .values({
        structureId: ctx.actor.structureId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: input.quantity.toDbString(),
        avgCostMinor: input.avgCostMinor,
        currencyCode: input.currencyCode,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [stockLevels.structureId, stockLevels.productId, stockLevels.warehouseId],
        set: {
          quantity: input.quantity.toDbString(),
          avgCostMinor: input.avgCostMinor,
          currencyCode: input.currencyCode,
          updatedAt: new Date(),
        },
      });
  },

  async insertMovement(
    ctx: TenantSessionContext,
    input: InsertMovementInput
  ): Promise<StockMovementRecord> {
    const [row] = await ctx.db
      .insert(stockMovements)
      .values({
        structureId: ctx.actor.structureId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        direction: input.direction,
        quantity: input.quantity.toDbString(),
        unitCostMinor: input.unitCostMinor,
        currencyCode: input.currencyCode,
        reason: input.reason,
        // `stock_movements_source_consistency_chk` (migration 0009)
        // requires `source_type = 'sale'` exactly when `sale_id` is set,
        // and NULL sale_id otherwise -- set both together, never one
        // without the other.
        sourceType: input.saleId ? "sale" : null,
        saleId: input.saleId ?? null,
        createdBy: ctx.actor.userId,
      })
      .returning();
    return movementToDomain(row);
  },

  async listMovements(
    ctx: TenantSessionContext,
    filter: ListMovementsFilter
  ): Promise<StockMovementRecord[]> {
    const conditions = [eq(stockMovements.structureId, ctx.actor.structureId)];
    if (filter.productId) {
      conditions.push(eq(stockMovements.productId, filter.productId));
    }
    if (filter.warehouseId) {
      conditions.push(eq(stockMovements.warehouseId, filter.warehouseId));
    }
    const rows = await ctx.db
      .select()
      .from(stockMovements)
      .where(and(...conditions))
      .orderBy(sql`${stockMovements.occurredAt} desc`)
      .limit(filter.limit ?? 100);
    return rows.map(movementToDomain);
  },

  async listDistinctProductWarehousePairs(ctx: TenantSessionContext): Promise<ProductWarehousePair[]> {
    const rows = await ctx.db.execute<{ product_id: string; warehouse_id: string }>(sql`
      select distinct product_id, warehouse_id
      from stock_movements
      where structure_id = ${ctx.actor.structureId}
    `);
    return rows.map((r) => ({ productId: r.product_id, warehouseId: r.warehouse_id }));
  },

  async listAllMovementsForRebuild(
    ctx: TenantSessionContext,
    productId: string,
    warehouseId: string
  ): Promise<StockMovementRecord[]> {
    // No limit -- H3 fix support (`rebuildStockLevels` must replay the
    // FULL ledger, unlike `listMovements`'s display-oriented cap of 100).
    const rows = await ctx.db
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.structureId, ctx.actor.structureId),
          eq(stockMovements.productId, productId),
          eq(stockMovements.warehouseId, warehouseId)
        )
      )
      .orderBy(asc(stockMovements.occurredAt), asc(stockMovements.id));
    return rows.map(movementToDomain);
  },
};
