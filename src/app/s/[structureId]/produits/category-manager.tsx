"use client";

import { useState } from "react";
import { X, Pencil, Trash2, Plus, ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { dict } from "@/lib/i18n";
import type {
  CategoryActionResult,
  DeleteCategoryActionResult,
  AssignCategoryActionResult,
} from "@/modules/catalog/api/actions";

export interface CategoryWithCount {
  id: string;
  parentId: string | null;
  name: string;
  productCount: number;
}

// Full-screen sheet (same pattern as the POS cart overlay) rather than a
// shadcn Dialog -- this codebase has no Radix dialog primitive yet and a
// bespoke fixed-overlay is consistent with what already exists.
export function CategoryManager({
  open,
  onClose,
  categories,
  createCategoryAction,
  updateCategoryAction,
  deleteCategoryAction,
  assignProductsToCategoryAction,
  productIdsByCategory,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  categories: CategoryWithCount[];
  createCategoryAction: (formData: FormData) => Promise<CategoryActionResult>;
  updateCategoryAction: (categoryId: string, formData: FormData) => Promise<CategoryActionResult>;
  deleteCategoryAction: (categoryId: string) => Promise<DeleteCategoryActionResult>;
  assignProductsToCategoryAction: (input: {
    categoryId: string | null;
    productIds: string[];
  }) => Promise<AssignCategoryActionResult>;
  productIdsByCategory: Map<string, string[]>;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dependents, setDependents] = useState<
    Record<string, { productCount: number; childCount: number; moveTarget: string }>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!open) return null;

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    const formData = new FormData();
    formData.set("name", newName.trim());
    const result = await createCategoryAction(formData);
    setCreating(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNewName("");
    onChanged();
  }

  async function handleRename(id: string) {
    if (!renameValue.trim()) return;
    setBusyId(id);
    const formData = new FormData();
    formData.set("name", renameValue.trim());
    const result = await updateCategoryAction(id, formData);
    setBusyId(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRenamingId(null);
    onChanged();
  }

  async function handleDelete(category: CategoryWithCount) {
    setBusyId(category.id);
    setError(null);
    const result = await deleteCategoryAction(category.id);
    setBusyId(null);
    if (result.ok) {
      onChanged();
      return;
    }
    if (result.code === "HAS_DEPENDENTS") {
      // Offer the move instead of surfacing the raw rejection -- this is
      // the "on crée le lot et on loge les produits dedans" flow in
      // reverse: emptying a rayon before removing it.
      setDependents((prev) => ({
        ...prev,
        [category.id]: {
          productCount: result.productCount,
          childCount: result.childCount,
          moveTarget: "",
        },
      }));
      return;
    }
    setError(result.message);
  }

  async function handleMoveThenDelete(category: CategoryWithCount) {
    const target = dependents[category.id]?.moveTarget ?? "";
    const productIds = productIdsByCategory.get(category.id) ?? [];
    if (productIds.length === 0) {
      // Only sub-categories left -- can't move those from here (shallow
      // nesting is expected to be rare; ask to handle them individually).
      setError(dict.categories.hasDependentsHint);
      return;
    }
    setBusyId(category.id);
    const result = await assignProductsToCategoryAction({
      categoryId: target || null,
      productIds,
    });
    if (!result.ok) {
      setBusyId(null);
      setError(result.message);
      return;
    }
    const deleteResult = await deleteCategoryAction(category.id);
    setBusyId(null);
    if (deleteResult.ok) {
      setDependents((prev) => {
        const { [category.id]: _removed, ...rest } = prev;
        return rest;
      });
      onChanged();
    } else if (deleteResult.code === "HAS_DEPENDENTS") {
      // Sub-categories still attached -- surface that specifically.
      setError(dict.categories.hasDependentsHint);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-base font-semibold">{dict.categories.title}</h2>
          <p className="text-xs text-muted-foreground">{dict.categories.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={dict.categories.close}
          className="flex h-touch w-touch items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {error && (
          <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            {error}
          </p>
        )}

        <div className="mb-4 flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={dict.categories.createPlaceholder}
            aria-label={dict.categories.createPlaceholder}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
          <Button onClick={handleCreate} loading={creating} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{dict.categories.createCta}</span>
          </Button>
        </div>

        {categories.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.categories.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {categories.map((category) => {
              const dependent = dependents[category.id];
              const otherCategories = categories.filter((c) => c.id !== category.id);
              return (
                <li key={category.id} className="p-3">
                  {renamingId === category.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        autoFocus
                        aria-label={dict.categories.renameCta}
                      />
                      <Button size="sm" onClick={() => handleRename(category.id)} loading={busyId === category.id}>
                        {dict.common.save}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenamingId(null)}>
                        {dict.common.cancel}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{category.name}</span>
                        <Badge variant="secondary">
                          {category.productCount} {dict.categories.productsCountSuffix}
                        </Badge>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          aria-label={dict.categories.renameCta}
                          onClick={() => {
                            setRenamingId(category.id);
                            setRenameValue(category.name);
                          }}
                          className="flex h-touch w-touch items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={dict.categories.deleteCta}
                          onClick={() => handleDelete(category)}
                          disabled={busyId === category.id}
                          className="flex h-touch w-touch items-center justify-center rounded-md text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  )}

                  {dependent && (
                    <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                      <p className="text-sm font-medium text-warning">
                        {dict.categories.hasDependentsTitle}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dependent.productCount} {dict.categories.productsCountSuffix}
                        {dependent.childCount > 0 ? ` · ${dependent.childCount} sous-rayon(s)` : ""}
                      </p>
                      {dependent.productCount > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <select
                            value={dependent.moveTarget}
                            onChange={(e) =>
                              setDependents((prev) => ({
                                ...prev,
                                [category.id]: { ...prev[category.id], moveTarget: e.target.value },
                              }))
                            }
                            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                            aria-label={dict.categories.moveTo}
                          >
                            <option value="">{dict.products.categoryFieldNone}</option>
                            {otherCategories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            onClick={() => handleMoveThenDelete(category)}
                            loading={busyId === category.id}
                          >
                            <ArrowRight className="h-4 w-4" aria-hidden="true" />
                            {dict.categories.moveSubmit}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
