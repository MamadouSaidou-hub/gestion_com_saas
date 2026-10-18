import { and, asc, eq, sql } from "drizzle-orm";
import { suppliers } from "@/db/schema/catalog";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  SupplierRepository,
  SupplierRecord,
  InsertSupplierInput,
  UpdateSupplierInput,
  ListSuppliersFilter,
} from "../application/ports";

type SupplierRow = typeof suppliers.$inferSelect;

function toDomain(row: SupplierRow): SupplierRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    createdAt: row.createdAt,
  };
}

export const supplierRepository: SupplierRepository = {
  async findById(ctx: TenantSessionContext, supplierId: string): Promise<SupplierRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.structureId, ctx.actor.structureId), eq(suppliers.id, supplierId)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async findByName(ctx: TenantSessionContext, name: string): Promise<SupplierRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.structureId, ctx.actor.structureId),
          sql`lower(${suppliers.name}) = lower(${name})`
        )
      )
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async list(ctx: TenantSessionContext, filter: ListSuppliersFilter): Promise<SupplierRecord[]> {
    const conditions = [eq(suppliers.structureId, ctx.actor.structureId)];
    if (filter.search) {
      conditions.push(sql`lower(${suppliers.name}) like lower(${"%" + filter.search + "%"})`);
    }
    const rows = await ctx.db
      .select()
      .from(suppliers)
      .where(and(...conditions))
      .orderBy(asc(suppliers.name));
    return rows.map(toDomain);
  },

  async insert(ctx: TenantSessionContext, input: InsertSupplierInput): Promise<SupplierRecord> {
    const [row] = await ctx.db
      .insert(suppliers)
      .values({
        structureId: ctx.actor.structureId,
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
      })
      .returning();
    return toDomain(row);
  },

  async update(
    ctx: TenantSessionContext,
    supplierId: string,
    input: UpdateSupplierInput
  ): Promise<SupplierRecord> {
    const patch: Partial<typeof suppliers.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.email !== undefined) patch.email = input.email;

    const [row] = await ctx.db
      .update(suppliers)
      .set(patch)
      .where(and(eq(suppliers.structureId, ctx.actor.structureId), eq(suppliers.id, supplierId)))
      .returning();
    return toDomain(row);
  },
};
