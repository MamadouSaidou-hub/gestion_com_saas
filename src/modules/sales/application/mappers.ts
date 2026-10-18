import { moneyToDto } from "@/platform/dto/money";
import type { ConfirmSaleLineResult, ConfirmSaleResult } from "./dto";
import type { SaleHeaderRecord, SaleLineRecord } from "./ports";

export function toConfirmSaleResult(
  header: SaleHeaderRecord,
  lines: SaleLineRecord[],
  replayed: boolean
): ConfirmSaleResult {
  if (header.ticketNumber === null || header.fiscalYear === null) {
    // Should never happen: a committed sale row is only ever visible to
    // another transaction once it has gone through the full confirm path
    // (see confirm-sale.ts's header comment on why a replay can never
    // observe a still-draft row).
    throw new Error(`Sale "${header.id}" has no ticket number -- not actually confirmed.`);
  }

  const lineResults: ConfirmSaleLineResult[] = lines
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceMinor: moneyToDto(line.unitPriceMinor),
      discountMinor: moneyToDto(line.discountMinor),
      vatRate: line.vatRate,
      unitCostMinor: moneyToDto(line.unitCostMinor),
      lineTotalMinor: moneyToDto(line.lineTotalMinor),
      lineNo: line.lineNo,
    }));

  return {
    saleId: header.id,
    ticketNumber: header.ticketNumber.toString(),
    fiscalYear: header.fiscalYear,
    currencyCode: header.currencyCode,
    subtotalMinor: moneyToDto(header.subtotalMinor),
    discountMinor: moneyToDto(header.discountMinor),
    vatMinor: moneyToDto(header.vatMinor),
    totalMinor: moneyToDto(header.totalMinor),
    paidMinor: moneyToDto(header.paidMinor),
    paymentStatus: header.paymentStatus,
    lines: lineResults,
    replayed,
  };
}
