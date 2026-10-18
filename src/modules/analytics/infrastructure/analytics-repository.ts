import { sql } from "drizzle-orm";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type {
  AnalyticsRepository,
  WindowArgs,
  EncaisseWindowArgs,
  SalesWindowTotals,
  MethodAmount,
  TopProductRow,
  MarginTotals,
  SellerRow,
  OwnSalesSummary,
} from "../application/ports";

// ---------------------------------------------------------------------------
// Direct indexed queries, read-only, against sales/sale_lines (sales
// module), payments (billing module), products/warehouses (catalog
// module). Analytics is a deliberate, documented EXCEPTION to the
// cross-module schema-import boundary (see docs/platform.md): a
// cross-cutting reporting module aggregating data owned by several other
// modules cannot reasonably be forced through each module's narrow
// CRUD-oriented service surface for a dashboard -- this is exactly what
// "direct indexed queries, no materialized view" in the coordinator's
// instruction implies. This file never WRITES to any of these tables.
//
// All numeric/bigint SQL aggregates (SUM, COUNT) come back from the
// `postgres` driver as STRINGS when computed via a raw `sql` template
// (Postgres SUM(bigint) returns NUMERIC, not BIGINT) -- every row is
// parsed explicitly below, never assumed to already be a JS
// number/bigint.
// ---------------------------------------------------------------------------

function toBigInt(value: unknown): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  return BigInt(String(value).split(".")[0]);
}

function toInt(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

// multi-store: every query below optionally ANDs in a parameterized
// `warehouse_id = $1` condition (never raw string interpolation) -- empty
// when `storeScope` is null (every store), filtered otherwise. This is the
// app-layer CEILING restated explicitly in SQL on top of RLS's FLOOR (the
// store-scope predicate already added to `sales`/`payments` in migration
// 0014) -- a gerant's query is filtered twice, provably, not just left to
// RLS alone.

export const analyticsRepository: AnalyticsRepository = {
  async getSalesWindowTotals(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<SalesWindowTotals> {
    const rows = await ctx.db.execute<{
      gross_count: unknown;
      gross_minor: unknown;
      net_count: unknown;
      net_minor: unknown;
    }>(sql`
      select
        count(*) as gross_count,
        coalesce(sum(total_minor), 0) as gross_minor,
        count(*) filter (where status = 'confirmed') as net_count,
        coalesce(sum(total_minor) filter (where status = 'confirmed'), 0) as net_minor
      from sales
      where structure_id = ${ctx.actor.structureId}
        and confirmed_at >= ${window.start.toISOString()}
        and confirmed_at < ${window.end.toISOString()}
        ${storeScope ? sql`and warehouse_id = ${storeScope}` : sql``}
    `);
    const row = rows[0];
    return {
      grossMinor: toBigInt(row?.gross_minor),
      grossCount: toInt(row?.gross_count),
      netMinor: toBigInt(row?.net_minor),
      netCount: toInt(row?.net_count),
    };
  },

  async getEncaisse(
    ctx: TenantSessionContext,
    window: EncaisseWindowArgs,
    storeScope: string | null
  ): Promise<bigint> {
    // H5 fix: no upper bound for the CURRENT window (window.end omitted)
    // -- see EncaisseWindowArgs's comment in ports.ts for why dropping it
    // is safe (a payment cannot legitimately be timestamped in the
    // future) and why it is the fix for the clock-drift false negative.
    const upperBound = window.end ? sql`and received_at < ${window.end.toISOString()}` : sql``;
    const storeFilter = storeScope ? sql`and warehouse_id = ${storeScope}` : sql``;
    const rows = await ctx.db.execute<{ total: unknown }>(sql`
      select coalesce(sum(amount_minor), 0) as total
      from payments
      where structure_id = ${ctx.actor.structureId}
        and received_at >= ${window.start.toISOString()}
        ${upperBound}
        ${storeFilter}
        and voided_at is null
    `);
    return toBigInt(rows[0]?.total);
  },

  async getEncaisseByMethod(
    ctx: TenantSessionContext,
    window: EncaisseWindowArgs,
    storeScope: string | null
  ): Promise<MethodAmount[]> {
    const upperBound = window.end ? sql`and received_at < ${window.end.toISOString()}` : sql``;
    const storeFilter = storeScope ? sql`and warehouse_id = ${storeScope}` : sql``;
    const rows = await ctx.db.execute<{ method: string; amount_minor: unknown }>(sql`
      select method, coalesce(sum(amount_minor), 0) as amount_minor
      from payments
      where structure_id = ${ctx.actor.structureId}
        and received_at >= ${window.start.toISOString()}
        ${upperBound}
        ${storeFilter}
        and voided_at is null
      group by method
    `);
    return rows.map((row) => ({ method: row.method, amountMinor: toBigInt(row.amount_minor) }));
  },

  async getTopProductsRaw(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<TopProductRow[]> {
    const storeFilter = storeScope ? sql`and s.warehouse_id = ${storeScope}` : sql``;
    const rows = await ctx.db.execute<{
      product_id: string;
      sku: string;
      name: string;
      revenue_minor: unknown;
      quantity: string;
    }>(sql`
      select
        sl.product_id as product_id,
        p.sku as sku,
        p.name as name,
        coalesce(sum(sl.line_total_minor), 0) as revenue_minor,
        coalesce(sum(sl.quantity), 0) as quantity
      from sale_lines sl
      join sales s on s.structure_id = sl.structure_id and s.id = sl.sale_id
      join products p on p.structure_id = sl.structure_id and p.id = sl.product_id
      where sl.structure_id = ${ctx.actor.structureId}
        and s.status = 'confirmed'
        and s.confirmed_at >= ${window.start.toISOString()}
        and s.confirmed_at < ${window.end.toISOString()}
        ${storeFilter}
      group by sl.product_id, p.sku, p.name
    `);
    return rows.map((row) => ({
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      revenueMinor: toBigInt(row.revenue_minor),
      quantity: row.quantity,
    }));
  },

  async getMarginTotals(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<MarginTotals> {
    // Correction (coordinator feedback): margin must compare COGS against
    // NET-of-VAT (HT) revenue, not TTC -- collected VAT is remitted to the
    // state, not revenue. Each line's HT amount is reconstructed from its
    // own `vat_rate` snapshot: line_total_minor * 10000 / (10000 +
    // vat_rate*100) -- e.g. vat_rate=18.00 -> divide by 11800/10000=1.18.
    // When vat_rate=0 (the common case -- most small shops aren't
    // VAT-registered, D4) this is exactly equal to line_total_minor, so
    // nothing changes for them.
    const storeFilter = storeScope ? sql`and s.warehouse_id = ${storeScope}` : sql``;
    const rows = await ctx.db.execute<{ revenue_minor_ht: unknown; cost_minor: unknown }>(sql`
      select
        coalesce(sum(round(sl.line_total_minor * 10000 / (10000 + sl.vat_rate * 100))), 0) as revenue_minor_ht,
        coalesce(round(sum(sl.quantity * sl.unit_cost_minor)), 0) as cost_minor
      from sale_lines sl
      join sales s on s.structure_id = sl.structure_id and s.id = sl.sale_id
      where sl.structure_id = ${ctx.actor.structureId}
        and s.status = 'confirmed'
        and s.confirmed_at >= ${window.start.toISOString()}
        and s.confirmed_at < ${window.end.toISOString()}
        ${storeFilter}
    `);
    const row = rows[0];
    return { revenueMinor: toBigInt(row?.revenue_minor_ht), costMinor: toBigInt(row?.cost_minor) };
  },

  async getSellerBreakdown(
    ctx: TenantSessionContext,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<SellerRow[]> {
    const storeFilter = storeScope ? sql`and warehouse_id = ${storeScope}` : sql``;
    const rows = await ctx.db.execute<{ seller_id: string; sale_count: unknown; total_minor: unknown }>(sql`
      select created_by as seller_id, count(*) as sale_count, coalesce(sum(total_minor), 0) as total_minor
      from sales
      where structure_id = ${ctx.actor.structureId}
        and status = 'confirmed'
        and confirmed_at >= ${window.start.toISOString()}
        and confirmed_at < ${window.end.toISOString()}
        ${storeFilter}
      group by created_by
    `);
    return rows.map((row) => ({
      sellerId: row.seller_id,
      saleCount: toInt(row.sale_count),
      totalMinor: toBigInt(row.total_minor),
    }));
  },

  async getOwnSalesSummary(
    ctx: TenantSessionContext,
    userId: string,
    window: WindowArgs,
    storeScope: string | null
  ): Promise<OwnSalesSummary> {
    const storeFilter = storeScope ? sql`and warehouse_id = ${storeScope}` : sql``;
    const rows = await ctx.db.execute<{ sale_count: unknown; total_minor: unknown }>(sql`
      select count(*) as sale_count, coalesce(sum(total_minor), 0) as total_minor
      from sales
      where structure_id = ${ctx.actor.structureId}
        and status = 'confirmed'
        and created_by = ${userId}
        and confirmed_at >= ${window.start.toISOString()}
        and confirmed_at < ${window.end.toISOString()}
        ${storeFilter}
    `);
    const row = rows[0];
    return { saleCount: toInt(row?.sale_count), totalMinor: toBigInt(row?.total_minor) };
  },
};
