"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, CheckSquare, ListFilter, Plus, Search, Square, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { CategoryManager } from "./category-manager";
import type {
  CategoryActionResult,
  DeleteCategoryActionResult,
  AssignCategoryActionResult,
} from "@/modules/catalog/api/actions";

export interface RealProduct {
  id: string;
  sku: string;
  name: string;
  defaultPriceMinor: string; // DTO money string -- XOF/GNF exponent 0, safe to Number() for display
  defaultCostMinor: string;
  lowStockThreshold: string | null;
  quantity: string; // numeric(18,4) string
  categoryId: string | null;
  categoryName: string | null;
}

export interface RealCategory {
  id: string;
  parentId: string | null;
  name: string;
}

const NO_CATEGORY_KEY = "__none__";

export function ProductListClient({
  structureId,
  structureName,
  currency,
  currencyCodeForActions,
  canEditCatalog,
  canReceiveStock,
  warehouseId,
  unitId,
  products,
  categories,
  createProductAction,
  receiveStockAction,
  createCategoryAction,
  updateCategoryAction,
  deleteCategoryAction,
  assignProductsToCategoryAction,
}: {
  structureId: string;
  structureName: string;
  currency: SupportedCurrency;
  currencyCodeForActions: string;
  canEditCatalog: boolean;
  canReceiveStock: boolean;
  warehouseId: string | null;
  unitId: string | null;
  products: RealProduct[];
  categories: RealCategory[];
  createProductAction: (formData: FormData) => Promise<unknown>;
  receiveStockAction: (formData: FormData) => Promise<unknown>;
  createCategoryAction: (formData: FormData) => Promise<CategoryActionResult>;
  updateCategoryAction: (categoryId: string, formData: FormData) => Promise<CategoryActionResult>;
  deleteCategoryAction: (categoryId: string) => Promise<DeleteCategoryActionResult>;
  assignProductsToCategoryAction: (input: {
    categoryId: string | null;
    productIds: string[];
  }) => Promise<AssignCategoryActionResult>;
}) {
  const [query, setQuery] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [receivingFor, setReceivingFor] = useState<string | null>(null);
  const [activeCategoryKey, setActiveCategoryKey] = useState<string | "all">("all");
  const [managerOpen, setManagerOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState<string>("");
  const [bulkMoving, setBulkMoving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // New-product form: pick an existing rayon, "sans rayon", or create one
  // inline -- the "let the shopkeeper set the rayon in the SAME trip" ask.
  const [formCategoryChoice, setFormCategoryChoice] = useState<string>("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submittingProduct, setSubmittingProduct] = useState(false);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) {
      const key = p.categoryId ?? NO_CATEGORY_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [products]);

  const productIdsByCategory = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of products) {
      if (!p.categoryId) continue;
      const list = map.get(p.categoryId) ?? [];
      list.push(p.id);
      map.set(p.categoryId, list);
    }
    return map;
  }, [products]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = products;
    if (activeCategoryKey !== "all") {
      list = list.filter((p) =>
        activeCategoryKey === NO_CATEGORY_KEY ? !p.categoryId : p.categoryId === activeCategoryKey
      );
    }
    if (q) {
      list = list.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    return list;
  }, [products, query, activeCategoryKey]);

  // Grouped view only makes sense when nothing is filtered to one rayon --
  // otherwise it's already a single group. Sold products with no rayon are
  // always shown last, as their own clearly-labelled bucket.
  const groups = useMemo(() => {
    if (activeCategoryKey !== "all") {
      return [{ key: activeCategoryKey, label: null, items: results }];
    }
    const byKey = new Map<string, RealProduct[]>();
    for (const p of results) {
      const key = p.categoryId ?? NO_CATEGORY_KEY;
      const list = byKey.get(key) ?? [];
      list.push(p);
      byKey.set(key, list);
    }
    const ordered: { key: string; label: string | null; items: RealProduct[] }[] = [];
    for (const category of categories) {
      const items = byKey.get(category.id);
      if (items && items.length > 0) {
        ordered.push({ key: category.id, label: category.name, items });
        byKey.delete(category.id);
      }
    }
    const rest = byKey.get(NO_CATEGORY_KEY);
    if (rest && rest.length > 0) {
      ordered.push({ key: NO_CATEGORY_KEY, label: dict.products.categoryFieldNone, items: rest });
    }
    return ordered;
  }, [results, activeCategoryKey, categories]);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkMove() {
    if (selectedIds.size === 0) return;
    setBulkMoving(true);
    setBulkError(null);
    const result = await assignProductsToCategoryAction({
      categoryId: bulkMoveTarget || null,
      productIds: Array.from(selectedIds),
    });
    setBulkMoving(false);
    if (!result.ok) {
      setBulkError(result.message);
      return;
    }
    setSelectedIds(new Set());
    setSelectMode(false);
    setBulkMoveTarget("");
  }

  async function handleCreateProduct(formData: FormData) {
    setFormError(null);
    let categoryId: string | null = formCategoryChoice || null;

    if (formCategoryChoice === "new") {
      if (!newCategoryName.trim()) {
        setFormError(dict.categories.createPlaceholder);
        return;
      }
      const categoryFormData = new FormData();
      categoryFormData.set("name", newCategoryName.trim());
      const categoryResult = await createCategoryAction(categoryFormData);
      if (!categoryResult.ok) {
        setFormError(categoryResult.message);
        return;
      }
      categoryId = categoryResult.category.id;
    }

    formData.set("categoryId", categoryId ?? "");
    setSubmittingProduct(true);
    await createProductAction(formData);
    setSubmittingProduct(false);
    setShowAddForm(false);
    setFormCategoryChoice("");
    setNewCategoryName("");
  }

  const categoriesWithCounts = categories.map((c) => ({
    ...c,
    productCount: categoryCounts.get(c.id) ?? 0,
  }));

  return (
    <div className="min-h-screen bg-background pb-6">
      <header className="sticky top-0 z-30 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <a
            href={`/s/${structureId}/dashboard`}
            aria-label="Retour au tableau de bord"
            className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{dict.products.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
          {canEditCatalog && (
            <button
              type="button"
              onClick={() => setSelectMode((v) => !v)}
              className={cn(
                "flex h-touch shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring",
                selectMode ? "border-primary bg-primary/10 text-primary" : "border-input hover:bg-accent"
              )}
            >
              {selectMode ? <CheckSquare className="h-4 w-4" aria-hidden="true" /> : <Square className="h-4 w-4" aria-hidden="true" />}
              <span className="hidden sm:inline">{dict.products.selectModeCta}</span>
            </button>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={dict.products.searchPlaceholder}
              className="pl-9"
              aria-label={dict.products.searchPlaceholder}
            />
          </div>
          {canEditCatalog && (
            <button
              type="button"
              onClick={() => setShowAddForm((v) => !v)}
              className="flex h-touch shrink-0 items-center gap-1.5 rounded-md border border-primary px-3 text-sm font-medium text-primary hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {showAddForm ? <X className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
              <span className="hidden sm:inline">{dict.products.addProduct}</span>
            </button>
          )}
        </div>

        {/* Rayon chips -- the backbone of "on crée le lot et on loge les
            produits dedans": fast navigation between rayons, same control
            family as the POS's chips so the mental model matches at the
            till and in the back office. */}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex flex-1 gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label={dict.categories.title}>
            <CategoryChip
              active={activeCategoryKey === "all"}
              onClick={() => setActiveCategoryKey("all")}
              label={dict.pos.categoryAllChip}
            />
            {categories.map((c) => (
              <CategoryChip
                key={c.id}
                active={activeCategoryKey === c.id}
                onClick={() => setActiveCategoryKey(c.id)}
                label={c.name}
                count={categoryCounts.get(c.id) ?? 0}
              />
            ))}
            {(categoryCounts.get(NO_CATEGORY_KEY) ?? 0) > 0 && (
              <CategoryChip
                active={activeCategoryKey === NO_CATEGORY_KEY}
                onClick={() => setActiveCategoryKey(NO_CATEGORY_KEY)}
                label={dict.pos.categoryNoneChip}
                count={categoryCounts.get(NO_CATEGORY_KEY) ?? 0}
              />
            )}
          </div>
          {canEditCatalog && (
            <button
              type="button"
              onClick={() => setManagerOpen(true)}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
              {dict.products.manageCategoriesCta}
            </button>
          )}
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.nav.captionGestion },
            { label: dict.products.title },
          ]}
        />
        {showAddForm && canEditCatalog && (
          <form
            action={handleCreateProduct}
            className="mb-4 space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <input type="hidden" name="unitId" value={unitId ?? ""} />
            <input type="hidden" name="currencyCode" value={currencyCodeForActions} />
            <h2 className="text-sm font-semibold">{dict.products.addProduct}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="sku">SKU</Label>
                <Input id="sku" name="sku" required maxLength={64} placeholder="SKU-001" />
              </div>
              <div>
                <Label htmlFor="defaultPriceMinor">{dict.products.columnPrice}</Label>
                <Input
                  id="defaultPriceMinor"
                  name="defaultPriceMinor"
                  type="number"
                  min={0}
                  step="1"
                  required
                  inputMode="numeric"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="name">{dict.products.columnProduct}</Label>
              <Input id="name" name="name" required maxLength={200} />
            </div>
            <div>
              <Label htmlFor="defaultCostMinor">Coût d&apos;achat (optionnel)</Label>
              <Input id="defaultCostMinor" name="defaultCostMinor" type="number" min={0} step="1" defaultValue={0} inputMode="numeric" />
            </div>
            <div>
              <Label htmlFor="categoryChoice">{dict.products.categoryFieldLabel}</Label>
              <select
                id="categoryChoice"
                value={formCategoryChoice}
                onChange={(e) => setFormCategoryChoice(e.target.value)}
                className="h-touch w-full rounded-md border border-input bg-background px-3 text-base"
              >
                <option value="">{dict.products.categoryFieldNone}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="new">{dict.products.categoryFieldNew}</option>
              </select>
              {formCategoryChoice === "new" && (
                <Input
                  className="mt-2"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder={dict.products.newCategoryNamePlaceholder}
                  aria-label={dict.products.newCategoryNamePlaceholder}
                />
              )}
            </div>
            {formError && <p className="text-sm font-medium text-destructive">{formError}</p>}
            <Button type="submit" className="w-full" disabled={!unitId || submittingProduct} loading={submittingProduct}>
              {dict.common.create}
            </Button>
          </form>
        )}

        <p className="mb-2 text-sm text-muted-foreground">
          {results.length} {dict.products.title.toLowerCase()}
        </p>

        {results.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.products.empty}</p>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.key}>
                {group.label && (
                  <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label} <span className="font-normal">({group.items.length})</span>
                  </h2>
                )}
                <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                  {group.items.map((product) => {
                    const quantity = Number(product.quantity);
                    const threshold = product.lowStockThreshold !== null ? Number(product.lowStockThreshold) : null;
                    const outOfStock = quantity <= 0;
                    const lowStock = !outOfStock && threshold !== null && quantity <= threshold;
                    const checked = selectedIds.has(product.id);
                    return (
                      <li key={product.id} className="p-4">
                        <div className="flex items-center gap-3">
                          {selectMode && (
                            <button
                              type="button"
                              onClick={() => toggleSelected(product.id)}
                              aria-pressed={checked}
                              aria-label={product.name}
                              className="flex h-touch w-touch shrink-0 items-center justify-center rounded-md text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              {checked ? <CheckSquare className="h-5 w-5" aria-hidden="true" /> : <Square className="h-5 w-5" aria-hidden="true" />}
                            </button>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{product.name}</p>
                            <p className="text-sm tabular-nums text-muted-foreground">
                              {formatMoney(Number(product.defaultPriceMinor), currency)}
                              <span className="mx-1" aria-hidden="true">
                                &middot;
                              </span>
                              {product.quantity}
                              <span className="mx-1" aria-hidden="true">
                                &middot;
                              </span>
                              {product.sku}
                            </p>
                          </div>
                          <Badge variant={outOfStock ? "destructive" : lowStock ? "warning" : "success"}>
                            {outOfStock ? dict.products.outOfStock : lowStock ? dict.products.lowStock : dict.products.inStock}
                          </Badge>
                        </div>

                        {canReceiveStock && warehouseId && !selectMode && (
                          <div className="mt-2">
                            {receivingFor === product.id ? (
                              <form
                                action={async (formData) => {
                                  await receiveStockAction(formData);
                                  setReceivingFor(null);
                                }}
                                className="flex items-end gap-2"
                              >
                                <input type="hidden" name="productId" value={product.id} />
                                <input type="hidden" name="warehouseId" value={warehouseId} />
                                <input type="hidden" name="currencyCode" value={currencyCodeForActions} />
                                <div className="flex-1">
                                  <Label htmlFor={`qty-${product.id}`} className="text-xs">
                                    {dict.products.quantityReceivedLabel}
                                  </Label>
                                  <Input id={`qty-${product.id}`} name="quantity" type="number" min={0} step="0.0001" required inputMode="decimal" className="h-9" />
                                </div>
                                <div className="flex-1">
                                  <Label htmlFor={`cost-${product.id}`} className="text-xs">
                                    {dict.products.unitCostLabel}
                                  </Label>
                                  <Input
                                    id={`cost-${product.id}`}
                                    name="unitCostMinor"
                                    type="number"
                                    min={0}
                                    step="1"
                                    defaultValue={product.defaultCostMinor}
                                    required
                                    inputMode="numeric"
                                    className="h-9"
                                  />
                                </div>
                                <Button type="submit" size="sm">
                                  OK
                                </Button>
                              </form>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setReceivingFor(product.id)}
                                className="text-sm font-medium text-primary hover:underline"
                              >
                                + {dict.products.receiveStockCta}
                              </button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </main>

      {selectMode && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-20 z-40 mx-auto max-w-2xl px-4">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-lg">
            <span className="whitespace-nowrap text-sm font-medium">
              {selectedIds.size} {dict.products.selectedCount}
            </span>
            <select
              value={bulkMoveTarget}
              onChange={(e) => setBulkMoveTarget(e.target.value)}
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              aria-label={dict.categories.moveTo}
            >
              <option value="">{dict.products.categoryFieldNone}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={handleBulkMove} loading={bulkMoving}>
              {dict.products.bulkMoveCta}
            </Button>
          </div>
          {bulkError && <p className="mt-1 text-xs font-medium text-destructive">{bulkError}</p>}
        </div>
      )}

      <CategoryManager
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        categories={categoriesWithCounts}
        createCategoryAction={createCategoryAction}
        updateCategoryAction={updateCategoryAction}
        deleteCategoryAction={deleteCategoryAction}
        assignProductsToCategoryAction={assignProductsToCategoryAction}
        productIdsByCategory={productIdsByCategory}
        onChanged={() => {
          // Server Actions revalidate the page's own data on the server
          // (Next re-renders the route after a Server Action resolves);
          // nothing else to do client-side.
        }}
      />
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        active ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-foreground hover:bg-accent"
      )}
    >
      {label}
      {count !== undefined && <span className="tabular-nums opacity-80">({count})</span>}
    </button>
  );
}
