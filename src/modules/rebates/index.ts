import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import { rebateRepository } from "./infrastructure/rebate-repository";
import * as useCases from "./application";
import type { CreateRebateScaleInput, CheckSupplierTierInput } from "./application";

// ---------------------------------------------------------------------------
// rebates/index.ts -- the ONLY surface another module is allowed to import
// from. Composition root wiring the concrete (drizzle) repository into the
// pure use cases.
//
// `checkAndGrantSupplierTier` is the ctx-based primitive purchasing's own
// Server Action calls with ITS OWN already-open ctx (same cross-module
// convention as billing calling sales' primitives) -- no permission check
// inside it, see check-and-grant-supplier-tier.ts's header comment.
// ---------------------------------------------------------------------------
export const rebatesService = {
  createRebateScale: (ctx: TenantSessionContext, input: CreateRebateScaleInput) =>
    useCases.createRebateScale(ctx, input, rebateRepository),
  calculateCustomerRebate: (ctx: TenantSessionContext, customerId: string) =>
    useCases.calculateCustomerRebate(ctx, customerId, rebateRepository),
  checkAndGrantSupplierTier: (ctx: TenantSessionContext, input: CheckSupplierTierInput) =>
    useCases.checkAndGrantSupplierTier(ctx, input, rebateRepository),
  verifyRebateTier: (ctx: TenantSessionContext, input: CheckSupplierTierInput) =>
    useCases.verifyRebateTier(ctx, input, rebateRepository),
  getCustomerRebateProgress: (ctx: TenantSessionContext, customerId: string) =>
    useCases.getCustomerRebateProgress(ctx, customerId, rebateRepository),
  getSupplierRebateProgress: (ctx: TenantSessionContext, supplierId: string) =>
    useCases.getSupplierRebateProgress(ctx, supplierId, rebateRepository),
  listRebateGrants: (ctx: TenantSessionContext, scaleId: string) =>
    useCases.listRebateGrants(ctx, scaleId, rebateRepository),
};

export type {
  CreateRebateScaleInput,
  RebateTierInput,
  RebateScaleDto,
  RebateTierDto,
  RebateGrantDto,
  RebateProgressDto,
  CheckSupplierTierInput,
  RebateModel,
  RebateMode,
  RebateGrantTrigger,
} from "./application";
export { RebateScaleNotFoundError, InvalidRebateScaleInputError } from "./domain/errors";
