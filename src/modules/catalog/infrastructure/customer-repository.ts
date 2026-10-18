import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { customers } from "@/db/schema/catalog";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  CustomerRepository,
  CustomerRecord,
  InsertCustomerInput,
  UpdateCustomerInput,
  ListCustomersFilter,
} from "../application/ports";

type CustomerRow = typeof customers.$inferSelect;

function toDomain(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    isActive: row.isActive,
    creditLimitMinor: row.creditLimitMinor,
    defaultPaymentTermsDays: row.defaultPaymentTermsDays,
    address: row.address,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

export const customerRepository: CustomerRepository = {
  async findByName(ctx: TenantSessionContext, name: string): Promise<CustomerRecord | null> {
    // M1 fix (security-reviewer, Medium): exact, case-insensitive match --
    // no ILIKE wildcard matching on free-text POS input (see header history
    // in git; comment kept for context on why this is `lower(...) = lower(...)`
    // and not `ilike`).
    const [row] = await ctx.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.structureId, ctx.actor.structureId),
          sql`lower(${customers.name}) = lower(${name})`
        )
      )
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async findById(ctx: TenantSessionContext, customerId: string): Promise<CustomerRecord | null> {
    const [row] = await ctx.db
      .select()
      .from(customers)
      .where(and(eq(customers.structureId, ctx.actor.structureId), eq(customers.id, customerId)))
      .limit(1);
    return row ? toDomain(row) : null;
  },

  async list(ctx: TenantSessionContext, filter: ListCustomersFilter): Promise<CustomerRecord[]> {
    const conditions = [eq(customers.structureId, ctx.actor.structureId)];
    if (filter.activeOnly) {
      conditions.push(eq(customers.isActive, true));
    }
    if (filter.ids) {
      // An empty array must mean "no customer qualifies", not "every
      // customer" -- inArray([]) is always false in Postgres, which is
      // exactly the wanted behaviour for a gerant with zero store activity.
      conditions.push(inArray(customers.id, filter.ids));
    }
    if (filter.search) {
      conditions.push(sql`lower(${customers.name}) like lower(${"%" + filter.search + "%"})`);
    }
    const rows = await ctx.db
      .select()
      .from(customers)
      .where(and(...conditions))
      .orderBy(asc(customers.name));
    return rows.map(toDomain);
  },

  async insert(ctx: TenantSessionContext, input: InsertCustomerInput): Promise<CustomerRecord> {
    const [row] = await ctx.db
      .insert(customers)
      .values({
        structureId: ctx.actor.structureId,
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        creditLimitMinor: input.creditLimitMinor ?? null,
        defaultPaymentTermsDays: input.defaultPaymentTermsDays ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    return toDomain(row);
  },

  async update(
    ctx: TenantSessionContext,
    customerId: string,
    input: UpdateCustomerInput
  ): Promise<CustomerRecord> {
    const patch: Partial<typeof customers.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.email !== undefined) patch.email = input.email;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.creditLimitMinor !== undefined) patch.creditLimitMinor = input.creditLimitMinor;
    if (input.defaultPaymentTermsDays !== undefined)
      patch.defaultPaymentTermsDays = input.defaultPaymentTermsDays;
    if (input.address !== undefined) patch.address = input.address;
    if (input.notes !== undefined) patch.notes = input.notes;

    const [row] = await ctx.db
      .update(customers)
      .set(patch)
      .where(and(eq(customers.structureId, ctx.actor.structureId), eq(customers.id, customerId)))
      .returning();
    return toDomain(row);
  },
};
