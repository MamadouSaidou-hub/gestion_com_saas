import { and, eq } from "drizzle-orm";
import { warehouses } from "@/db/schema/catalog";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  WarehouseRepository,
  WarehouseRecord,
  CreateWarehouseInput,
  ListWarehousesFilter,
} from "../application/ports";

// Drizzle implementation of the WarehouseRepository port -- one of the few
// files in catalog allowed to import `@/db/schema/catalog` directly
// (enforced by the ESLint layering rule).

type WarehouseRow = typeof warehouses.$inferSelect;

function toDomain(row: WarehouseRow): WarehouseRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    isDefault: row.isDefault,
    isActive: row.isActive,
    address: row.address,
    phone: row.phone,
    createdAt: row.createdAt,
  };
}

export const warehouseRepository: WarehouseRepository = {
  async findById(ctx: TenantSessionContext, warehouseId: string): Promise<WarehouseRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.structureId, ctx.actor.structureId), eq(warehouses.id, warehouseId)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async findByCode(ctx: TenantSessionContext, code: string): Promise<WarehouseRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.structureId, ctx.actor.structureId), eq(warehouses.code, code)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async list(ctx: TenantSessionContext, filter: ListWarehousesFilter): Promise<WarehouseRecord[]> {
    const conditions = [eq(warehouses.structureId, ctx.actor.structureId)];
    if (filter.activeOnly) {
      conditions.push(eq(warehouses.isActive, true));
    }
    if (filter.kind) {
      conditions.push(eq(warehouses.kind, filter.kind));
    }
    const rows = await ctx.db
      .select()
      .from(warehouses)
      .where(and(...conditions))
      .orderBy(warehouses.name);
    return rows.map(toDomain);
  },

  async insert(ctx: TenantSessionContext, input: CreateWarehouseInput): Promise<WarehouseRecord> {
    const [row] = await ctx.db
      .insert(warehouses)
      .values({
        structureId: ctx.actor.structureId,
        code: input.code,
        name: input.name,
        kind: input.kind,
        address: input.address ?? null,
        phone: input.phone ?? null,
        // Never created as the default from this path -- the implicit
        // default warehouse is seeded once by createStructure(); changing
        // which store is "default" is out of scope for this screen.
        isDefault: false,
        isActive: true,
      })
      .returning();
    return toDomain(row);
  },

  async setActive(
    ctx: TenantSessionContext,
    warehouseId: string,
    isActive: boolean
  ): Promise<WarehouseRecord> {
    const [row] = await ctx.db
      .update(warehouses)
      .set({ isActive })
      .where(and(eq(warehouses.structureId, ctx.actor.structureId), eq(warehouses.id, warehouseId)))
      .returning();
    return toDomain(row);
  },
};
