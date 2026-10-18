import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { transfersRepository } from "./infrastructure/transfers-repository";
import { stockCountsRepository } from "./infrastructure/stock-counts-repository";
import * as useCases from "./application";
import type {
  CreateTransferInput,
  CancelTransferInput,
  OpenStockCountInput,
  ValidateStockCountInput,
  ListTransfersFilter,
  ListStockCountsFilter,
  ListVarianceLinesFilter,
} from "./application";

// ---------------------------------------------------------------------------
// stock-transfers/index.ts -- the ONLY surface another module (or this
// module's own api/) is allowed to import from. Composition root: wires
// the concrete (drizzle) repositories into the pure use cases.
//
// Both tables families (transfers, physical counts) live in this ONE
// module because they share a single schema file (stock-transfers.ts,
// migration 0014) -- same "one module per schema file" convention as
// every other module here, not a merge of two otherwise-unrelated domains.
// ---------------------------------------------------------------------------

export const stockTransfersService = {
  createTransfer: (ctx: TenantSessionContext, input: CreateTransferInput) =>
    useCases.createTransfer(ctx, input, transfersRepository),
  receiveTransfer: (ctx: TenantSessionContext, transferId: string) =>
    useCases.receiveTransfer(ctx, transferId, transfersRepository),
  cancelTransfer: (ctx: TenantSessionContext, input: CancelTransferInput) =>
    useCases.cancelTransfer(ctx, input, transfersRepository),
  listTransfers: (ctx: TenantSessionContext, filter: ListTransfersFilter) =>
    useCases.listTransfers(ctx, filter, transfersRepository),
  exportTransfersCsv: (ctx: TenantSessionContext, filter: ListTransfersFilter) =>
    useCases.exportTransfersCsv(ctx, filter, transfersRepository),
  getInTransitByProduct: (ctx: TenantSessionContext, storeScope: string | null) =>
    useCases.getInTransitByProduct(ctx, storeScope, transfersRepository),

  openStockCount: (ctx: TenantSessionContext, input: OpenStockCountInput) =>
    useCases.openStockCount(ctx, input, stockCountsRepository),
  validateStockCount: (ctx: TenantSessionContext, input: ValidateStockCountInput) =>
    useCases.validateStockCount(ctx, input, stockCountsRepository),
  listStockCounts: (ctx: TenantSessionContext, filter: ListStockCountsFilter) =>
    useCases.listStockCounts(ctx, filter, stockCountsRepository),
  listVarianceLines: (ctx: TenantSessionContext, filter: ListVarianceLinesFilter) =>
    useCases.listVarianceLines(ctx, filter, stockCountsRepository),
};

export type {
  CreateTransferInput,
  CreateTransferLineInput,
  TransferDto,
  TransferLineDto,
  CancelTransferInput,
  OpenStockCountInput,
  StockCountDto,
  StockCountLineDto,
  ValidateStockCountInput,
  ValidateStockCountLineInput,
  VarianceLineDto,
  ListTransfersFilter,
  ListStockCountsFilter,
  ListVarianceLinesFilter,
  TransferStatus,
  StockCountStatus,
} from "./application";
export {
  InvalidTransferInputError,
  TransferNotFoundError,
  TransferNotInTransitError,
  TransferIdempotencyKeyReuseError,
  InvalidStockCountInputError,
  StockCountNotFoundError,
  StockCountNotDraftError,
} from "./domain";
