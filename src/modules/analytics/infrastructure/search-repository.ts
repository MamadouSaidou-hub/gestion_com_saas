import { sql } from "drizzle-orm";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  GlobalSearchRepository,
  ProductSearchRow,
  CustomerSearchRow,
  SupplierSearchRow,
  SaleSearchRow,
  TransferSearchRow,
} from "../application/search-ports";

// ---------------------------------------------------------------------------
// Direct indexed queries, read-only -- see search-ports.ts's header
// comment. products/customers/suppliers use pg_trgm's `%` similarity
// operator against the GIN indexes migration 0016 installed in
// `extensions` (confirmed indexed/working for `app_user` by that
// migration's own verification query) -- NOT a plain ILIKE, which would
// not use those indexes the same way. sales/transfers use a plain
// prefix/exact match (no trigram index was added for them -- only
// products/customers/suppliers got one, per the brief).
// ---------------------------------------------------------------------------

function toBigIntString(value: unknown): string {
  if (value === null || value === undefined) return "0";
  return String(value).split(".")[0];
}

export const globalSearchRepository: GlobalSearchRepository = {
  async searchProducts(ctx: TenantSessionContext, query: string, limit: number): Promise<ProductSearchRow[]> {
    const rows = await ctx.db.execute<{ id: string; sku: string; name: string }>(sql`
      select id, sku, name
      from products
      where structure_id = ${ctx.actor.structureId}
        and is_active = true
        and (name OPERATOR(extensions.%) ${query} or sku OPERATOR(extensions.%) ${query})
      order by greatest(extensions.similarity(name, ${query}), extensions.similarity(sku, ${query})) desc
      limit ${limit}
    `);
    return rows.map((r) => ({ productId: r.id, sku: r.sku, name: r.name }));
  },

  async searchCustomers(ctx: TenantSessionContext, query: string, limit: number): Promise<CustomerSearchRow[]> {
    const rows = await ctx.db.execute<{ id: string; name: string; phone: string | null }>(sql`
      select id, name, phone
      from customers
      where structure_id = ${ctx.actor.structureId}
        and (
          name OPERATOR(extensions.%) ${query}
          or (phone is not null and phone OPERATOR(extensions.%) ${query})
        )
      order by greatest(
        extensions.similarity(name, ${query}),
        extensions.similarity(coalesce(phone, ''), ${query})
      ) desc
      limit ${limit}
    `);
    return rows.map((r) => ({ customerId: r.id, name: r.name, phone: r.phone }));
  },

  async searchSuppliers(ctx: TenantSessionContext, query: string, limit: number): Promise<SupplierSearchRow[]> {
    const rows = await ctx.db.execute<{ id: string; name: string }>(sql`
      select id, name
      from suppliers
      where structure_id = ${ctx.actor.structureId}
        and name OPERATOR(extensions.%) ${query}
      order by extensions.similarity(name, ${query}) desc
      limit ${limit}
    `);
    return rows.map((r) => ({ supplierId: r.id, name: r.name }));
  },

  async searchSales(
    ctx: TenantSessionContext,
    query: string,
    limit: number,
    createdBy: string | undefined,
    storeScope: string | null
  ): Promise<SaleSearchRow[]> {
    const createdByFilter = createdBy ? sql`and created_by = ${createdBy}` : sql``;
    const storeFilter = storeScope ? sql`and warehouse_id = ${storeScope}` : sql``;
    const rows = await ctx.db.execute<{ id: string; ticket_number: unknown }>(sql`
      select id, ticket_number
      from sales
      where structure_id = ${ctx.actor.structureId}
        and status = 'confirmed'
        and ticket_number is not null
        and ticket_number::text like ${query + "%"}
        ${createdByFilter}
        ${storeFilter}
      order by confirmed_at desc
      limit ${limit}
    `);
    return rows.map((r) => ({ saleId: r.id, ticketNumber: toBigIntString(r.ticket_number) }));
  },

  async searchTransfers(
    ctx: TenantSessionContext,
    query: string,
    limit: number,
    storeScope: string | null
  ): Promise<TransferSearchRow[]> {
    // OR across both legs -- a transfer is legitimately visible from its
    // origin AND destination store, same convention as the store-scope RLS
    // predicate added in migration 0014.
    const storeFilter = storeScope
      ? sql`and (from_warehouse_id = ${storeScope} or to_warehouse_id = ${storeScope})`
      : sql``;
    const rows = await ctx.db.execute<{ id: string; reference: string }>(sql`
      select id, reference
      from stock_transfers
      where structure_id = ${ctx.actor.structureId}
        and reference ilike ${query + "%"}
        ${storeFilter}
      order by created_at desc
      limit ${limit}
    `);
    return rows.map((r) => ({ transferId: r.id, reference: r.reference }));
  },
};
