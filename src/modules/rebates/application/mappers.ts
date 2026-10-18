import { moneyToDto } from "@/platform/dto/money";
import type { RebateTierDto, RebateScaleDto, RebateGrantDto } from "./dto";
import type { RebateTierRecord, RebateScaleRecord, RebateGrantRecord } from "./ports";

export function toRebateTierDto(record: RebateTierRecord): RebateTierDto {
  return {
    id: record.id,
    thresholdQty: record.thresholdQty.toDbString(),
    rebatePerUnitMinor: moneyToDto(record.rebatePerUnitMinor),
  };
}

export function toRebateScaleDto(record: RebateScaleRecord, tiers: RebateTierRecord[]): RebateScaleDto {
  return {
    id: record.id,
    customerId: record.customerId,
    supplierId: record.supplierId,
    model: record.model,
    mode: record.mode,
    currencyCode: record.currencyCode,
    cycleStartedAt: record.cycleStartedAt?.toISOString() ?? null,
    isActive: record.isActive,
    tiers: tiers.map(toRebateTierDto),
  };
}

export function toRebateGrantDto(record: RebateGrantRecord): RebateGrantDto {
  return {
    id: record.id,
    scaleId: record.scaleId,
    model: record.model,
    periodLabel: record.periodLabel,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    countedQty: record.countedQty.toDbString(),
    tierThresholdQty: record.tierThresholdQty.toDbString(),
    rebatePerUnitMinor: moneyToDto(record.rebatePerUnitMinor),
    totalRebateMinor: moneyToDto(record.totalRebateMinor),
    currencyCode: record.currencyCode,
    grantedAt: record.grantedAt.toISOString(),
    grantedBy: record.grantedBy,
    trigger: record.trigger,
  };
}
