// DESIGN MOCKUP DATA -- sample catalog for a Senegal/Guinea boutique, used
// only to make the POS screen demonstrable before a real catalog module
// exists. Prices are plausible retail prices in major currency units (D8:
// exponent 0 for XOF/GNF, so "price" here already IS the displayed amount).
// Replace with a real `products`/`stock` query once that module lands --
// keep the same shape (id/name/price/stock) so the UI doesn't need to change.
export interface MockProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  lowStockThreshold: number;
  unit: string;
}

export const MOCK_CATALOG: MockProduct[] = [
  { id: "p1", name: "Riz parfumé 25kg", price: 15000, stock: 3, lowStockThreshold: 5, unit: "sac" },
  { id: "p2", name: "Huile végétale 5L", price: 6500, stock: 0, lowStockThreshold: 4, unit: "bidon" },
  { id: "p3", name: "Sucre en poudre 1kg", price: 750, stock: 6, lowStockThreshold: 10, unit: "sachet" },
  { id: "p4", name: "Savon de Marseille", price: 500, stock: 42, lowStockThreshold: 10, unit: "unité" },
  { id: "p5", name: "Lait en poudre 400g", price: 2200, stock: 18, lowStockThreshold: 10, unit: "boîte" },
  { id: "p6", name: "Thé Touba 100g", price: 1000, stock: 25, lowStockThreshold: 10, unit: "sachet" },
  { id: "p7", name: "Concentré de tomate", price: 400, stock: 60, lowStockThreshold: 15, unit: "boîte" },
  { id: "p8", name: "Bouteille d'eau 1.5L", price: 300, stock: 90, lowStockThreshold: 20, unit: "bouteille" },
  { id: "p9", name: "Spaghetti 500g", price: 650, stock: 33, lowStockThreshold: 10, unit: "paquet" },
  { id: "p10", name: "Gaz butane 6kg", price: 7500, stock: 2, lowStockThreshold: 3, unit: "bouteille" },
  { id: "p11", name: "Bougies (lot de 6)", price: 600, stock: 15, lowStockThreshold: 5, unit: "lot" },
  { id: "p12", name: "Allumettes", price: 100, stock: 120, lowStockThreshold: 30, unit: "boîte" },
];
