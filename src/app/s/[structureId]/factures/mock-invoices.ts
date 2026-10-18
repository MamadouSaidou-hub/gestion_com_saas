// DESIGN MOCKUP DATA -- sample invoices. The real `invoices`/billing module
// (D4: TVA/legal mentions/numbering per tenant/country) doesn't exist yet;
// this file exists only to make the list screen demonstrable. `amount` is a
// whole-unit integer (D8, exponent 0). Dates are ISO strings (no timezone
// ambiguity for a date-only field).
export type InvoiceStatus = "paid" | "pending" | "overdue";

export interface MockInvoice {
  id: string;
  number: string;
  clientName: string;
  amount: number;
  status: InvoiceStatus;
  issuedOn: string;
  dueOn: string;
}

export const MOCK_INVOICES: MockInvoice[] = [
  { id: "i1", number: "FA-2026-041", clientName: "Boutique Keur Massar", amount: 275000, status: "paid", issuedOn: "2026-10-02", dueOn: "2026-10-16" },
  { id: "i2", number: "FA-2026-042", clientName: "Hôtel Teranga Plaza", amount: 980000, status: "pending", issuedOn: "2026-10-09", dueOn: "2026-10-23" },
  { id: "i3", number: "FA-2026-043", clientName: "Restaurant Le Baobab", amount: 142500, status: "overdue", issuedOn: "2026-09-20", dueOn: "2026-10-04" },
  { id: "i4", number: "FA-2026-044", clientName: "Supermarché Sahel", amount: 612000, status: "paid", issuedOn: "2026-10-11", dueOn: "2026-10-25" },
  { id: "i5", number: "FA-2026-045", clientName: "Pharmacie Les Almadies", amount: 58000, status: "pending", issuedOn: "2026-10-14", dueOn: "2026-10-28" },
  { id: "i6", number: "FA-2026-046", clientName: "Cantine Université Cheikh Anta Diop", amount: 335000, status: "overdue", issuedOn: "2026-09-28", dueOn: "2026-10-12" },
];
