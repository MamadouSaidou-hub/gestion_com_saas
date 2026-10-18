"use client";

import { useState, useTransition } from "react";
import { ArrowLeft, Archive, Plus, Store, Warehouse as WarehouseIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import {
  createWarehouseAction,
  archiveWarehouseAction,
} from "@/modules/catalog/api/actions";
import type { WarehouseDto } from "@/modules/catalog";

export function MagasinsClient({
  structureId,
  structureName,
  initialWarehouses,
  isOwner,
}: {
  structureId: string;
  structureName: string;
  initialWarehouses: WarehouseDto[];
  isOwner: boolean;
}) {
  const [warehouses, setWarehouses] = useState(initialWarehouses);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createWarehouseAction(structureId, formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setWarehouses((prev) => [...prev, result.warehouse]);
      setShowForm(false);
    });
  }

  function handleArchive(warehouseId: string) {
    setError(null);
    startTransition(async () => {
      const result = await archiveWarehouseAction(structureId, warehouseId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setWarehouses((prev) => prev.map((w) => (w.id === warehouseId ? result.warehouse : w)));
    });
  }

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
            <h1 className="truncate text-base font-semibold">{dict.warehouses.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{structureName}</p>
          </div>
          {isOwner && (
            <Button type="button" size="sm" onClick={() => setShowForm((s) => !s)}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {dict.warehouses.createCta}
            </Button>
          )}
        </div>
      </header>

      <main className="px-4 py-3">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.nav.captionGestion },
            { label: dict.warehouses.title },
          ]}
        />
        <p className="mb-3 text-sm text-muted-foreground">{dict.warehouses.subtitle}</p>

        {error && (
          <p role="alert" className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {isOwner && showForm && (
          <Card className="mb-4">
            <CardContent className="p-4">
              <form
                action={(formData) => handleCreate(formData)}
                className="space-y-3"
              >
                <div>
                  <Label htmlFor="code">{dict.warehouses.codeLabel}</Label>
                  <Input id="code" name="code" required maxLength={20} placeholder={dict.warehouses.codePlaceholder} />
                </div>
                <div>
                  <Label htmlFor="name">{dict.warehouses.nameLabel}</Label>
                  <Input id="name" name="name" required maxLength={200} placeholder={dict.warehouses.namePlaceholder} />
                </div>
                <div>
                  <Label htmlFor="kind">{dict.warehouses.kindLabel}</Label>
                  <select
                    id="kind"
                    name="kind"
                    defaultValue="store"
                    className="flex h-touch w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <option value="store">{dict.warehouses.kindStore}</option>
                    <option value="depot">{dict.warehouses.kindDepot}</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="address">{dict.warehouses.addressLabel}</Label>
                  <Input id="address" name="address" maxLength={500} />
                </div>
                <div>
                  <Label htmlFor="phone">{dict.warehouses.phoneLabel}</Label>
                  <Input id="phone" name="phone" maxLength={20} />
                </div>
                <Button type="submit" disabled={isPending} className="w-full">
                  {dict.warehouses.createSubmit}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {warehouses.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">{dict.warehouses.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {warehouses.map((warehouse) => {
              const Icon = warehouse.kind === "store" ? Store : WarehouseIcon;
              return (
                <li key={warehouse.id} className="flex items-center gap-3 p-4">
                  <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {warehouse.name} <span className="text-xs text-muted-foreground">({warehouse.code})</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {warehouse.kind === "store" ? dict.warehouses.storeBadge : dict.warehouses.depotBadge}
                      {warehouse.isDefault && (
                        <>
                          {" "}
                          <span aria-hidden="true">&middot;</span> {dict.warehouses.defaultBadge}
                        </>
                      )}
                    </p>
                  </div>
                  <Badge variant={warehouse.isActive ? "secondary" : "outline"} className="shrink-0">
                    {warehouse.isActive ? dict.warehouses.active : dict.warehouses.archived}
                  </Badge>
                  {isOwner && warehouse.isActive && !warehouse.isDefault && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleArchive(warehouse.id)}
                      aria-label={`${dict.warehouses.archiveCta} ${warehouse.name}`}
                    >
                      <Archive className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
