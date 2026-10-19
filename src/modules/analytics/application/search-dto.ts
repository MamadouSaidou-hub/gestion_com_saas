export interface SearchResultDto {
  products: Array<{ productId: string; sku: string; name: string }>;
  customers: Array<{ customerId: string; name: string; phone: string | null }>;
  suppliers: Array<{ supplierId: string; name: string }>;
  sales: Array<{ saleId: string; ticketNumber: string }>;
  transfers: Array<{ transferId: string; reference: string }>;
}
