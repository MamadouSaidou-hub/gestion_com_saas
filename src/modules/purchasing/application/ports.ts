import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { Quantity } from "@/modules/inventory";

export type DeliveryPaymentStatus = "unpaid" | "partial" | "paid";

export interface DeliveryRecord {
  id: string;
  supplierId: string;
  warehouseId: string;
  reference: string;
  fiscalYear: number;
  currencyCode: string;
  totalMinor: bigint;
  paidMinor: bigint;
  paymentStatus: DeliveryPaymentStatus;
  dueAt: Date | null;
  receivedAt: Date | null;
  createdBy: string;
  idempotencyKey: string;
  requestFingerprint: string;
  cancelledAt: Date | null;
}

export interface DeliveryLineRecord {
  id: string;
  deliveryId: string;
  productId: string;
  quantity: Quantity;
  unitCostMinor: bigint;
  lineTotalMinor: bigint;
  lineNo: number;
}

export interface InsertDeliveryDraftInput {
  supplierId: string;
  warehouseId: string;
  currencyCode: string;
  idempotencyKey: string;
  requestFingerprint: string;
  createdBy: string;
}

export interface InsertDeliveryLineInput {
  productId: string;
  quantity: Quantity;
  unitCostMinor: bigint;
  lineTotalMinor: bigint;
  lineNo: number;
}

export interface FinalizeDeliveryHeaderInput {
  reference: string;
  fiscalYear: number;
  totalMinor: bigint;
  paymentStatus: DeliveryPaymentStatus;
  receivedAt: Date;
  dueAt: Date | null;
}

export interface ListDeliveriesFilter {
  supplierId?: string;
  // multi-store ceiling -- `null` = every store the actor can see (owner),
  // a warehouse id restricts to that one store (gerant), resolved by the
  // caller via resolveStoreScope, never guessed here.
  storeScope: string | null;
}

export interface DeliveryRepository {
  tryInsertDraft(ctx: TenantSessionContext, input: InsertDeliveryDraftInput): Promise<DeliveryRecord | null>;
  findByIdempotencyKey(ctx: TenantSessionContext, idempotencyKey: string): Promise<DeliveryRecord | null>;
  findById(ctx: TenantSessionContext, deliveryId: string): Promise<DeliveryRecord | null>;
  insertLines(
    ctx: TenantSessionContext,
    deliveryId: string,
    lines: InsertDeliveryLineInput[]
  ): Promise<DeliveryLineRecord[]>;
  listLines(ctx: TenantSessionContext, deliveryId: string): Promise<DeliveryLineRecord[]>;
  finalizeHeader(
    ctx: TenantSessionContext,
    deliveryId: string,
    input: FinalizeDeliveryHeaderInput
  ): Promise<DeliveryRecord>;
  list(ctx: TenantSessionContext, filter: ListDeliveriesFilter): Promise<DeliveryRecord[]>;
  // Tenant-level supplier debt (never store-scoped, see module header note):
  // Σ total_minor - Σ paid_minor across every non-cancelled delivery for
  // this supplier.
  sumDebtBySupplier(ctx: TenantSessionContext, supplierId: string): Promise<bigint>;
  // Same aggregate, across EVERY supplier of the tenant -- treasury's
  // "we owe suppliers" figure. Tenant-level only, by the same product
  // decision as sumDebtBySupplier (supplier debt is consolidated at
  // tenant level, never attributed to a single store).
  sumTotalDebt(ctx: TenantSessionContext): Promise<bigint>;
  // Rebates' supplier-side cyclic read dependency -- Σ quantity of every
  // non-cancelled delivery line whose delivery's received_at is STRICTLY
  // GREATER than `sinceExclusive` (so the delivery that closed a cycle is
  // never recounted). Exposed here, not read directly by the rebates
  // module (no cross-module schema import) -- see purchasing/index.ts.
  sumDeliveredQuantitySince(
    ctx: TenantSessionContext,
    supplierId: string,
    sinceExclusive: Date
  ): Promise<Quantity>;
}

export interface SupplierPaymentRecord {
  id: string;
  supplierId: string;
  deliveryId: string | null;
  amountMinor: bigint;
  currencyCode: string;
  method: string;
  reference: string | null;
  paidAt: Date;
  createdBy: string;
  idempotencyKey: string;
  voidedAt: Date | null;
}

export interface InsertSupplierPaymentInput {
  supplierId: string;
  deliveryId: string | null;
  amountMinor: bigint;
  currencyCode: string;
  method: string;
  reference: string | null;
  paidAt: Date;
  createdBy: string;
  idempotencyKey: string;
}

export interface SupplierPaymentAllocationInput {
  supplierPaymentId: string;
  deliveryId: string;
  amountMinor: bigint;
  currencyCode: string;
}

export interface SupplierPaymentRepository {
  tryInsert(
    ctx: TenantSessionContext,
    input: InsertSupplierPaymentInput
  ): Promise<SupplierPaymentRecord | null>;
  findByIdempotencyKey(
    ctx: TenantSessionContext,
    idempotencyKey: string
  ): Promise<SupplierPaymentRecord | null>;
  findById(ctx: TenantSessionContext, paymentId: string): Promise<SupplierPaymentRecord | null>;
  // C1-class fix (the exact bug named in the brief): conditional on
  // `voided_at IS NULL` in the SAME statement -- the arbiter, mirrors
  // billing's markVoided. Returns null when already voided.
  markVoided(ctx: TenantSessionContext, paymentId: string, voidedAt: Date): Promise<SupplierPaymentRecord | null>;
  insertAllocation(ctx: TenantSessionContext, input: SupplierPaymentAllocationInput): Promise<void>;
  findAllocationByPaymentId(
    ctx: TenantSessionContext,
    paymentId: string
  ): Promise<{ deliveryId: string; amountMinor: bigint } | null>;
}
