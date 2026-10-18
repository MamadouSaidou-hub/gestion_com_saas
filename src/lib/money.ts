// Money formatting -- Senegal (XOF) and Guinea (GNF) only (D8: one currency
// per structure, both with exponent 0 in practice, i.e. no decimal/minor
// unit shown to the user even though amounts are stored as integers).
//
// Deliberately NOT using `Intl.NumberFormat(locale, { style: "currency" })`:
// its XOF/GNF symbol output is inconsistent across JS engines/ICU data
// (sometimes "XOF", sometimes "F CFA") and not guaranteed to match what
// cashiers actually expect to read locally. Grouping is computed via
// `Intl.NumberFormat("fr-FR")` (reliable, locale-correct thousands
// separator) and the currency label is appended from our own table, so it
// stays stable and easy to extend/i18n later.
export type SupportedCurrency = "XOF" | "GNF";

const CURRENCY_LABEL: Record<SupportedCurrency, string> = {
  XOF: "FCFA",
  GNF: "FG",
};

const grouping = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

/**
 * Formats a whole-unit amount (no decimals -- XOF/GNF exponent is 0) with a
 * French thousands separator and the local currency label, e.g.
 * `formatMoney(15000, "XOF")` -> "15 000 FCFA".
 */
export function formatMoney(amount: number, currency: SupportedCurrency): string {
  return `${grouping.format(Math.round(amount))} ${CURRENCY_LABEL[currency]}`;
}
