"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  listActiveInventoryItems,
  listCathConsumablesCatalog,
  listCathConsumablesFacilities,
  upsertCathConsumable,
  type CathConsumableCatalogInput,
  type CathConsumableCatalogItem,
} from "@/lib/api/cathConsumables";
import { payloadIdentity } from "@/lib/idempotencyKey";

import { CatalogForm, CATH_CONSUMABLE_CATEGORIES } from "./CatalogForm";

const CATALOG_QUERY_KEY = ["cath-consumables", "catalog"] as const;
const FACILITY_QUERY_KEY = ["cath-consumables", "facilities"] as const;
const INVENTORY_QUERY_KEY = [
  "pharmacy-supply",
  "inventory-items",
  "active",
] as const;

function catalogPayload(
  item: CathConsumableCatalogItem,
  status = item.status,
): CathConsumableCatalogInput {
  return {
    id: item.id,
    item_name: item.item_name,
    category: item.category,
    manufacturer: item.manufacturer,
    model: item.model,
    is_implant: item.is_implant,
    batch_tracked: item.batch_tracked,
    default_unit_cost_reference: item.default_unit_cost_reference,
    billing_item_code: item.billing_item_code,
    inventory_item_id: item.inventory_item_id,
    status,
  };
}

function categoryLabel(value: string) {
  return (
    CATH_CONSUMABLE_CATEGORIES.find((category) => category.value === value)
      ?.label ?? value.replaceAll("_", " ")
  );
}

export function CatalogTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("active");
  const deferredSearch = useDeferredValue(search.trim());
  const [editingItem, setEditingItem] =
    useState<CathConsumableCatalogItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [inventorySearch, setInventorySearch] = useState("");
  const deferredInventorySearch = useDeferredValue(inventorySearch.trim());
  const [facilityId, setFacilityId] = useState<number | null>(null);

  const facilitiesQuery = useQuery({
    queryKey: FACILITY_QUERY_KEY,
    queryFn: () => listCathConsumablesFacilities(),
    staleTime: 5 * 60 * 1000,
  });
  // Memoised because this feeds the auto-select effect's dependency array:
  // as a bare `?? []` logical expression it produced a fresh array identity
  // every render, which react-hooks/exhaustive-deps flags.
  const facilities = useMemo(
    () => facilitiesQuery.data?.facilities ?? [],
    [facilitiesQuery.data],
  );

  // Auto-select only when the tenant has exactly one active facility: with a
  // single option there is nothing to infer. With none or several the selector
  // stays empty and the catalog read never fires, because guessing which
  // facility an operator meant would invent a facility fact the server refuses
  // to invent for us.
  useEffect(() => {
    if (facilityId !== null || facilities.length !== 1) return;
    setFacilityId(facilities[0].id);
  }, [facilities, facilityId]);

  const catalogQuery = useQuery({
    queryKey: [
      ...CATALOG_QUERY_KEY,
      facilityId,
      deferredSearch,
      category,
      status,
    ],
    queryFn: () => {
      if (facilityId === null) {
        throw new Error(
          "Select a facility before loading the cath consumable catalog",
        );
      }
      return listCathConsumablesCatalog({
        facility_id: facilityId,
        q: deferredSearch || undefined,
        category: category || undefined,
        status: status || undefined,
        limit: 500,
      });
    },
    enabled: facilityId !== null,
  });
  const inventoryQuery = useQuery({
    queryKey: [...INVENTORY_QUERY_KEY, deferredInventorySearch],
    queryFn: () =>
      listActiveInventoryItems({
        q: deferredInventorySearch || undefined,
        limit: 50,
      }),
    enabled: formOpen,
    staleTime: 5 * 60 * 1000,
  });

  // One attempt = one key. `keyFor` is stable while the payload identity is
  // unchanged, so a double-click or the 401→refresh replay in `api/core.ts`
  // reuses the key and the backend replays its recorded response instead of
  // saving twice. `reset()` on success ends the attempt, so a deliberate
  // second edit that lands on the same payload identity — retire, activate,
  // retire again — is a genuinely separate save rather than a swallowed replay.
  const catalogSaveKey = useIdempotencyKey("cath-consumable-catalog-upsert");

  const saveMutation = useMutation({
    mutationFn: (payload: CathConsumableCatalogInput) =>
      upsertCathConsumable(
        payload,
        catalogSaveKey.keyFor(payloadIdentity(payload)),
      ),
    onSuccess: (_result, payload) => {
      catalogSaveKey.reset();
      toast.success(payload.id ? "Catalog item updated" : "Catalog item added");
      setEditingItem(null);
      setFormOpen(false);
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Catalog item could not be saved",
      );
    },
  });

  const items = catalogQuery.data?.items ?? [];
  const inventoryItems = inventoryQuery.data?.items ?? [];

  function openCreate() {
    setEditingItem(null);
    setInventorySearch("");
    setFormOpen(true);
  }

  function openEdit(item: CathConsumableCatalogItem) {
    setEditingItem(item);
    setInventorySearch("");
    setFormOpen(true);
  }

  function toggleRetired(item: CathConsumableCatalogItem) {
    const nextStatus = item.status === "retired" ? "active" : "retired";
    saveMutation.mutate(catalogPayload(item, nextStatus));
  }

  return (
    <section aria-labelledby="cath-catalog-heading" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="cath-catalog-heading"
            className="text-xl font-semibold text-foreground"
          >
            Cath consumable catalog
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Manage implant and consumable identity, batch rules, inventory
            links, owner-supplied costs, and inert billing mappings.
          </p>
        </div>
        <button
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          onClick={openCreate}
          type="button"
        >
          Add catalog item
        </button>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[minmax(200px,1fr)_200px_180px_160px_auto]">
        <label className="text-xs font-medium text-muted-foreground">
          Facility
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) =>
              setFacilityId(
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
            value={facilityId === null ? "" : String(facilityId)}
          >
            <option value="">Select a facility</option>
            {facilities.map((facility) => (
              <option key={facility.id} value={String(facility.id)}>
                {facility.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Search
          <input
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Item, model, billing code, inventory"
            type="search"
            value={search}
          />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Category
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) => setCategory(event.target.value)}
            value={category}
          >
            <option value="">All categories</option>
            {CATH_CONSUMABLE_CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Status
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) => setStatus(event.target.value)}
            value={status}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
          </select>
        </label>
        <div className="flex items-end">
          <button
            className="h-10 w-full rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
            onClick={() => void catalogQuery.refetch()}
            type="button"
          >
            Refresh
          </button>
        </div>
      </div>

      {facilityId === null ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            description={
              facilitiesQuery.isFetching
                ? "Loading the facility list."
                : facilities.length === 0
                  ? "No active facility is available for this tenant, so the facility-scoped cath catalog cannot be read."
                  : "The cath consumable catalog is facility-scoped. Choose the facility whose catalog you are managing."
            }
            title="Facility required"
          />
        </div>
      ) : catalogQuery.isLoading ? (
        <LoadingSpinner label="Loading cath consumables" />
      ) : catalogQuery.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {catalogQuery.error instanceof Error
            ? catalogQuery.error.message
            : "Cath consumables could not be loaded"}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            action={
              !search && !category && status === "active" ? (
                <button
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  onClick={openCreate}
                  type="button"
                >
                  Add first item
                </button>
              ) : undefined
            }
            description={
              !search && !category && status === "active"
                ? "Add the owner-approved cath catalog before clinical usage capture begins."
                : "Adjust the search or filters to see more catalog items."
            }
            title={
              !search && !category && status === "active"
                ? "No cath catalog items"
                : "No matching items"
            }
          />
        </div>
      ) : (
        <CatalogTable
          items={items}
          mutationPending={saveMutation.isPending}
          onEdit={openEdit}
          onToggleRetired={toggleRetired}
        />
      )}

      <p className="text-xs text-muted-foreground">
        Showing {items.length} of {catalogQuery.data?.count ?? items.length}{" "}
        items.
      </p>

      {formOpen ? (
        <CatalogForm
          key={editingItem?.id ?? "new"}
          inventoryItems={inventoryItems}
          inventoryError={inventoryQuery.error}
          inventoryLoading={inventoryQuery.isFetching}
          inventorySearch={inventorySearch}
          item={editingItem}
          onCancel={() => {
            setEditingItem(null);
            setFormOpen(false);
          }}
          onSubmit={(payload) => saveMutation.mutate(payload)}
          onInventorySearchChange={setInventorySearch}
          submitting={saveMutation.isPending}
        />
      ) : null}
    </section>
  );
}

function CatalogTable({
  items,
  mutationPending,
  onEdit,
  onToggleRetired,
}: {
  items: CathConsumableCatalogItem[];
  mutationPending: boolean;
  onEdit: (item: CathConsumableCatalogItem) => void;
  onToggleRetired: (item: CathConsumableCatalogItem) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[1080px] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Item</th>
            <th className="px-4 py-3 font-medium">Category</th>
            <th className="px-4 py-3 font-medium">Tracking</th>
            <th className="px-4 py-3 font-medium">Inventory link</th>
            <th className="px-4 py-3 font-medium">Cost reference</th>
            <th className="px-4 py-3 font-medium">Billing mapping</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => (
            <tr
              className={item.status === "retired" ? "opacity-60" : ""}
              key={item.id}
            >
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">{item.item_name}</p>
                <p className="text-xs text-muted-foreground">
                  {[item.manufacturer, item.model]
                    .filter(Boolean)
                    .join(" · ") || "No manufacturer/model"}
                </p>
              </td>
              <td className="px-4 py-3 capitalize">
                {categoryLabel(item.category)}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {item.is_implant ? (
                    <Badge tone="violet">Implant</Badge>
                  ) : null}
                  {item.batch_tracked ? (
                    <Badge tone="blue">Batch + expiry</Badge>
                  ) : null}
                  {!item.is_implant && !item.batch_tracked ? (
                    <Badge>Standard</Badge>
                  ) : null}
                </div>
              </td>
              <td className="px-4 py-3">
                {item.inventory_item_id ? (
                  <>
                    <p className="font-medium text-foreground">
                      {item.inventory_item_name ??
                        `Inventory #${item.inventory_item_id}`}
                    </p>
                    <p className="text-xs text-muted-foreground">Linked</p>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not linked</span>
                )}
              </td>
              <td className="px-4 py-3 tabular-nums">
                {item.default_unit_cost_reference ?? "—"}
              </td>
              <td className="px-4 py-3">
                {item.billing_item_code ? (
                  <span className="font-mono text-xs text-emerald-700 dark:text-emerald-300">
                    {item.billing_item_code}
                  </span>
                ) : (
                  <Badge tone="amber">Unmapped</Badge>
                )}
              </td>
              <td className="px-4 py-3 capitalize">{item.status}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-2">
                  <button
                    className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                    onClick={() => onEdit(item)}
                    type="button"
                  >
                    Edit
                  </button>
                  <button
                    aria-label={`${item.status === "retired" ? "Activate" : "Retire"} ${item.item_name}`}
                    className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                    disabled={mutationPending}
                    onClick={() => onToggleRetired(item)}
                    type="button"
                  >
                    {item.status === "retired" ? "Activate" : "Retire"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "amber" | "blue" | "violet";
}) {
  const classes = {
    neutral: "bg-muted text-muted-foreground",
    amber:
      "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
    blue: "bg-blue-100 text-blue-900 dark:bg-blue-950/50 dark:text-blue-200",
    violet:
      "bg-violet-100 text-violet-900 dark:bg-violet-950/50 dark:text-violet-200",
  }[tone];
  return (
    <span
      className={`rounded-full px-2 py-1 text-[11px] font-medium ${classes}`}
    >
      {children}
    </span>
  );
}
