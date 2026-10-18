// DESIGN MOCKUP DATA -- sample stock movements (ledger entries), mirroring
// D9's real source of truth: the `stock_movements` table. No projection/
// CUMP computation is wired up here since the real ledger doesn't exist yet
// -- this is sample movement history only, shaped to match it (product,
// direction, quantity, reason, resulting on-hand count) so swapping in the
// real query later doesn't change the layout. Reuses product names from the
// POS/produits mock catalog so the three screens feel like one store.
export type MovementDirection = "in" | "out";

export interface MockStockMovement {
  id: string;
  productName: string;
  unit: string;
  direction: MovementDirection;
  quantity: number;
  reason: string;
  resultingStock: number;
  occurredOn: string; // ISO datetime
}

export const MOCK_STOCK_MOVEMENTS: MockStockMovement[] = [
  { id: "m1", productName: "Riz parfumé 25kg", unit: "sac", direction: "in", quantity: 20, reason: "Réapprovisionnement", resultingStock: 23, occurredOn: "2026-10-15T09:10:00Z" },
  { id: "m2", productName: "Riz parfumé 25kg", unit: "sac", direction: "out", quantity: 17, reason: "Ventes de la semaine", resultingStock: 3, occurredOn: "2026-10-16T18:40:00Z" },
  { id: "m3", productName: "Huile végétale 5L", unit: "bidon", direction: "out", quantity: 12, reason: "Ventes de la semaine", resultingStock: 0, occurredOn: "2026-10-16T19:05:00Z" },
  { id: "m4", productName: "Sucre en poudre 1kg", unit: "sachet", direction: "in", quantity: 30, reason: "Réapprovisionnement", resultingStock: 36, occurredOn: "2026-10-14T08:00:00Z" },
  { id: "m5", productName: "Sucre en poudre 1kg", unit: "sachet", direction: "out", quantity: 30, reason: "Ventes de la semaine", resultingStock: 6, occurredOn: "2026-10-16T17:15:00Z" },
  { id: "m6", productName: "Gaz butane 6kg", unit: "bouteille", direction: "out", quantity: 1, reason: "Casse/perte", resultingStock: 2, occurredOn: "2026-10-13T12:00:00Z" },
  { id: "m7", productName: "Savon de Marseille", unit: "unité", direction: "in", quantity: 50, reason: "Réapprovisionnement", resultingStock: 42, occurredOn: "2026-10-10T11:20:00Z" },
  { id: "m8", productName: "Lait en poudre 400g", unit: "boîte", direction: "out", quantity: 6, reason: "Ventes de la semaine", resultingStock: 18, occurredOn: "2026-10-16T16:00:00Z" },
];
