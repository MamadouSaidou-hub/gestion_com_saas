import type { MoneyMinorDto } from "@/platform/dto/money";
import type { RebateModel, RebateMode, RebateGrantTrigger } from "./ports";

export interface RebateTierInput {
  thresholdQty: string; // numeric(18,4) string
  rebatePerUnitMinor: MoneyMinorDto;
}

export interface CreateRebateScaleInput {
  customerId?: string | null;
  supplierId?: string | null;
  currencyCode: string;
  tiers: RebateTierInput[];
}

export interface RebateTierDto {
  id: string;
  thresholdQty: string;
  rebatePerUnitMinor: MoneyMinorDto;
}

export interface RebateScaleDto {
  id: string;
  customerId: string | null;
  supplierId: string | null;
  model: RebateModel;
  mode: RebateMode;
  currencyCode: string;
  cycleStartedAt: string | null;
  isActive: boolean;
  tiers: RebateTierDto[];
}

export interface RebateGrantDto {
  id: string;
  scaleId: string;
  model: RebateModel;
  periodLabel: string | null;
  periodStart: string;
  periodEnd: string;
  countedQty: string;
  tierThresholdQty: string;
  rebatePerUnitMinor: MoneyMinorDto;
  totalRebateMinor: MoneyMinorDto;
  currencyCode: string;
  grantedAt: string;
  grantedBy: string | null;
  trigger: RebateGrantTrigger;
}

// "Barème" progress view -- units so far this period/cycle, tier reached
// (if any), the rebate it implies, and how many units remain to the next
// tier. Informational display only -- never a balance.
export interface RebateProgressDto {
  scale: RebateScaleDto;
  countedQty: string;
  periodLabel: string | null;
  periodStart: string;
  periodEnd: string | null; // null for an open-ended cyclic window ("so far")
  tierReached: RebateTierDto | null;
  projectedRebateMinor: MoneyMinorDto | null; // countedQty x tierReached.rebatePerUnitMinor, if any
  nextTier: RebateTierDto | null;
  unitsToNextTier: string | null; // numeric(18,4) string
}
