// DESIGN MOCKUP DATA -- sample suppliers for a Senegal/Guinea boutique. The
// `fournisseurs` business module (real supplier records, purchase orders,
// payment terms) doesn't exist yet -- this file exists only to make the
// list screen demonstrable before that module lands. `balanceOwed` is a
// whole-unit amount (D8: integer, exponent 0 for XOF/GNF) representing what
// the structure currently owes this supplier; 0 means settled.
export interface MockSupplier {
  id: string;
  name: string;
  contactName: string;
  phone: string; // E.164 (D7), e.g. "+221771234567"
  balanceOwed: number;
}

export const MOCK_SUPPLIERS: MockSupplier[] = [
  { id: "f1", name: "Grossiste Sahel Riz", contactName: "Moussa Diop", phone: "+221771234567", balanceOwed: 450000 },
  { id: "f2", name: "Huilerie du Fleuve", contactName: "Aïssatou Ba", phone: "+221776543210", balanceOwed: 0 },
  { id: "f3", name: "Distributions Teranga", contactName: "Cheikh Fall", phone: "+221709876543", balanceOwed: 125000 },
  { id: "f4", name: "Comptoir Mamou Gaz", contactName: "Sékou Camara", phone: "+224622334455", balanceOwed: 0 },
  { id: "f5", name: "Import-Export Dakar", contactName: "Fatou Sow", phone: "+221781122334", balanceOwed: 980000 },
  { id: "f6", name: "Savonnerie Rufisque", contactName: "Ibrahima Ndiaye", phone: "+221705566778", balanceOwed: 32000 },
];
