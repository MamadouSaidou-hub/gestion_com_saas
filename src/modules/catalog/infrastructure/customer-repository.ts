import { and, eq, sql } from "drizzle-orm";
import { customers } from "@/db/schema/catalog";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { CustomerRepository, CustomerRecord, InsertCustomerInput } from "../application/ports";

export const customerRepository: CustomerRepository = {
  async findByName(ctx: TenantSessionContext, name: string): Promise<CustomerRecord | null> {
    // M1 fix (security-reviewer, Medium): was `ilike(customers.name, name)`
    // -- `%`/`_` in free-text POS input are ILIKE wildcards, so a name
    // containing one matched an ARBITRARY existing customer and misposted
    // the receivable to the wrong account. Exact, case-insensitive
    // comparison instead (`lower(name) = lower(input)`, no pattern
    // matching at all).
    const [row] = await ctx.db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(
        and(
          eq(customers.structureId, ctx.actor.structureId),
          sql`lower(${customers.name}) = lower(${name})`
        )
      )
      .limit(1);
    return row ?? null;
  },

  async insert(ctx: TenantSessionContext, input: InsertCustomerInput): Promise<CustomerRecord> {
    const [row] = await ctx.db
      .insert(customers)
      .values({ structureId: ctx.actor.structureId, name: input.name })
      .returning({ id: customers.id, name: customers.name });
    return row;
  },
};
