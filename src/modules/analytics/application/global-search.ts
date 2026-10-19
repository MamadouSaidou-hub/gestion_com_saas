import { can, scopeFor, resolveStoreScope } from "@/modules/tenancy/permissions";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { GlobalSearchRepository } from "./search-ports";
import type { SearchResultDto } from "./search-dto";

const LIMIT_PER_SECTION = 5;
const MIN_QUERY_LENGTH = 2;

// ---------------------------------------------------------------------------
// globalSearch -- ONE Server Action, ONE round trip, five independent
// sections fired in PARALLEL inside the caller's single
// `withTenantSession` (same discipline as getDashboard). Each section is
// gated on its own permission AND, where relevant, the actor's store
// scope -- filtered in the QUERY (never fetched then hidden): an actor
// without `supplier:read` never issues the suppliers query at all, and a
// store-scoped actor's sales/transfers queries carry their own store
// filter at the SQL level, same as every other store-scoped repository
// call in this codebase.
// ---------------------------------------------------------------------------
export async function globalSearch(
  ctx: TenantSessionContext,
  rawQuery: string,
  repo: GlobalSearchRepository
): Promise<SearchResultDto> {
  const query = rawQuery.trim();
  const empty: SearchResultDto = { products: [], customers: [], suppliers: [], sales: [], transfers: [] };
  if (query.length < MIN_QUERY_LENGTH) {
    return empty;
  }

  const storeScope = resolveStoreScope(ctx.actor, null);

  const [products, customers, suppliers, sales, transfers] = await Promise.all([
    can(ctx.actor, "product:read") ? repo.searchProducts(ctx, query, LIMIT_PER_SECTION) : Promise.resolve([]),
    can(ctx.actor, "customer:read") ? repo.searchCustomers(ctx, query, LIMIT_PER_SECTION) : Promise.resolve([]),
    can(ctx.actor, "supplier:read") ? repo.searchSuppliers(ctx, query, LIMIT_PER_SECTION) : Promise.resolve([]),
    can(ctx.actor, "sale:read")
      ? repo.searchSales(
          ctx,
          query,
          LIMIT_PER_SECTION,
          scopeFor(ctx.actor, "sale:read") === "own" ? ctx.actor.userId : undefined,
          storeScope
        )
      : Promise.resolve([]),
    can(ctx.actor, "transfer:read")
      ? repo.searchTransfers(ctx, query, LIMIT_PER_SECTION, storeScope)
      : Promise.resolve([]),
  ]);

  return { products, customers, suppliers, sales, transfers };
}
