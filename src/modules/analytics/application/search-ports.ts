import type { TenantSessionContext } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// GlobalSearchRepository -- a SECOND, documented direct-indexed-query
// exception in the SAME analytics module (see ports.ts's header comment
// and docs/platform.md): one round trip, five independent sections, each
// filtered by permission AND store at the SQL level, LIMIT 5 each. This is
// read-only, never writes, same rule as AnalyticsRepository.
// ---------------------------------------------------------------------------

export interface ProductSearchRow {
  productId: string;
  sku: string;
  name: string;
}

export interface CustomerSearchRow {
  customerId: string;
  name: string;
  phone: string | null;
}

export interface SupplierSearchRow {
  supplierId: string;
  name: string;
}

export interface SaleSearchRow {
  saleId: string;
  ticketNumber: string; // bigint-as-string, never a number (D8-adjacent discipline)
}

export interface TransferSearchRow {
  transferId: string;
  reference: string;
}

export interface GlobalSearchRepository {
  // Trigram-indexed (`products_name_trgm_idx` / `products_sku_trgm_idx`,
  // migration 0016) -- no store dimension, products aren't store-scoped.
  searchProducts(ctx: TenantSessionContext, query: string, limit: number): Promise<ProductSearchRow[]>;
  // Trigram-indexed (`customers_name_trgm_idx` / `customers_phone_trgm_idx`)
  // -- no store dimension, a customer has no home store (same convention
  // as getReceivablesByCustomer/the clients screen).
  searchCustomers(ctx: TenantSessionContext, query: string, limit: number): Promise<CustomerSearchRow[]>;
  // Trigram-indexed (`suppliers_name_trgm_idx`) -- tenant-level, no store
  // dimension (suppliers aren't store-scoped either).
  searchSuppliers(ctx: TenantSessionContext, query: string, limit: number): Promise<SupplierSearchRow[]>;
  // Exact/prefix match on `ticket_number` (bigint) -- `createdBy` filters
  // to the actor's own sales when `scope === "own"`; `storeScope` filters
  // to one store.
  searchSales(
    ctx: TenantSessionContext,
    query: string,
    limit: number,
    createdBy: string | undefined,
    storeScope: string | null
  ): Promise<SaleSearchRow[]>;
  // Prefix match on `reference`. `storeScope` matches EITHER leg
  // (from_warehouse_id OR to_warehouse_id), same OR convention as every
  // other store-scoped transfer query in this codebase.
  searchTransfers(
    ctx: TenantSessionContext,
    query: string,
    limit: number,
    storeScope: string | null
  ): Promise<TransferSearchRow[]>;
}
