"use client";

import { useState } from "react";

import type {
  CathConsumableCatalogInput,
  CathConsumableCatalogItem,
  InventoryLookupItem,
} from "@/lib/api/cathConsumables";

export const CATH_CONSUMABLE_CATEGORIES = [
  { value: "stent", label: "Stent" },
  { value: "balloon", label: "Balloon" },
  { value: "guidewire", label: "Guidewire" },
  { value: "catheter", label: "Catheter" },
  { value: "sheath", label: "Sheath" },
  { value: "closure_device", label: "Closure device" },
  { value: "pacemaker", label: "Pacemaker" },
  { value: "lead", label: "Lead" },
  { value: "other", label: "Other" },
] as const;

const DEFAULT_BATCH_TRACKED_CATEGORIES = new Set([
  "stent",
  "pacemaker",
  "lead",
]);

type CathConsumableCategory = CathConsumableCatalogItem["category"];
type CathConsumableStatus = CathConsumableCatalogItem["status"];

interface CatalogFormState {
  item_name: string;
  category: CathConsumableCategory;
  manufacturer: string;
  model: string;
  is_implant: boolean;
  batch_tracked: boolean;
  default_unit_cost_reference: string;
  billing_item_code: string;
  reused_billing_item_code: string;
  inventory_item_id: string;
  status: CathConsumableStatus;
}

function initialState(
  item: CathConsumableCatalogItem | null,
): CatalogFormState {
  return {
    item_name: item?.item_name ?? "",
    category: item?.category ?? "other",
    manufacturer: item?.manufacturer ?? "",
    model: item?.model ?? "",
    is_implant: item?.is_implant ?? false,
    batch_tracked: item?.batch_tracked ?? false,
    default_unit_cost_reference:
      item?.default_unit_cost_reference === null ||
      item?.default_unit_cost_reference === undefined
        ? ""
        : String(item.default_unit_cost_reference),
    billing_item_code: item?.billing_item_code ?? "",
    reused_billing_item_code: item?.reused_billing_item_code ?? "",
    inventory_item_id:
      item?.inventory_item_id === null || item?.inventory_item_id === undefined
        ? ""
        : String(item.inventory_item_id),
    status: item?.status ?? "active",
  };
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function CatalogForm({
  item,
  inventoryItems,
  inventoryError,
  inventoryLoading,
  inventorySearch,
  submitting,
  onCancel,
  onInventorySearchChange,
  onSubmit,
}: {
  item: CathConsumableCatalogItem | null;
  inventoryItems: InventoryLookupItem[];
  inventoryError: unknown;
  inventoryLoading: boolean;
  inventorySearch: string;
  submitting: boolean;
  onCancel: () => void;
  onInventorySearchChange: (value: string) => void;
  onSubmit: (payload: CathConsumableCatalogInput) => void;
}) {
  const [form, setForm] = useState<CatalogFormState>(() => initialState(item));
  const [selectedInventoryItem, setSelectedInventoryItem] =
    useState<InventoryLookupItem | null>(() =>
      item?.inventory_item_id
        ? {
            id: item.inventory_item_id,
            sku_code: item.inventory_sku ?? "",
            display_name:
              item.inventory_item_name ??
              `Inventory #${item.inventory_item_id}`,
            manufacturer: item.manufacturer,
            status: "active",
          }
        : null,
    );
  const [validationError, setValidationError] = useState<string | null>(null);
  const categoryRequiresImplant = DEFAULT_BATCH_TRACKED_CATEGORIES.has(
    form.category,
  );
  const batchTrackingRequired = categoryRequiresImplant || form.is_implant;
  const inventoryChoices =
    selectedInventoryItem &&
    !inventoryItems.some((option) => option.id === selectedInventoryItem.id)
      ? [selectedInventoryItem, ...inventoryItems]
      : inventoryItems;

  function update<K extends keyof CatalogFormState>(
    key: K,
    value: CatalogFormState[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeCategory(category: CathConsumableCategory) {
    setForm((current) => ({
      ...current,
      category,
      batch_tracked:
        current.batch_tracked || DEFAULT_BATCH_TRACKED_CATEGORIES.has(category),
      is_implant:
        current.is_implant || DEFAULT_BATCH_TRACKED_CATEGORIES.has(category),
    }));
  }

  function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const itemName = form.item_name.trim();
    if (!itemName) {
      setValidationError("Item name is required.");
      return;
    }

    const cost = optionalNumber(form.default_unit_cost_reference);
    if (
      form.default_unit_cost_reference.trim() &&
      (cost === null || cost < 0)
    ) {
      setValidationError("Default unit cost must be a non-negative number.");
      return;
    }

    const payload: CathConsumableCatalogInput = {
      ...(item ? { id: item.id } : {}),
      item_name: itemName,
      category: form.category,
      manufacturer: form.manufacturer.trim() || null,
      model: form.model.trim() || null,
      is_implant: form.is_implant,
      batch_tracked: form.batch_tracked,
      default_unit_cost_reference: cost,
      billing_item_code: form.billing_item_code.trim() || null,
      // Empty means "no separate reuse tariff" — the emitter then falls back to
      // billing_item_code, so a blank field must clear the column rather than
      // store an empty string the service-master will never match.
      reused_billing_item_code: form.reused_billing_item_code.trim() || null,
      inventory_item_id: optionalNumber(form.inventory_item_id),
      status: form.status,
    };
    setValidationError(null);
    onSubmit(payload);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        aria-labelledby="cath-catalog-form-title"
        aria-modal="true"
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-2xl"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="cath-catalog-form-title"
              className="text-xl font-semibold text-foreground"
            >
              {item ? "Edit cath catalog item" : "Add cath catalog item"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Billing remains inert until an owner-supplied billing code is
              mapped.
            </p>
          </div>
          <button
            aria-label="Close catalog form"
            className="rounded-md px-2 py-1 text-xl text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </div>

        <form className="mt-6 space-y-5" onSubmit={submitForm}>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Item name" required>
              <input
                aria-label="Item name"
                autoFocus
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) => update("item_name", event.target.value)}
                value={form.item_name}
              />
            </FormField>
            <FormField label="Category" required>
              <select
                aria-label="Category"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) =>
                  changeCategory(event.target.value as CathConsumableCategory)
                }
                value={form.category}
              >
                {CATH_CONSUMABLE_CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Manufacturer">
              <input
                aria-label="Manufacturer"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) => update("manufacturer", event.target.value)}
                value={form.manufacturer}
              />
            </FormField>
            <FormField label="Model">
              <input
                aria-label="Model"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) => update("model", event.target.value)}
                value={form.model}
              />
            </FormField>
            <FormField label="Linked inventory item">
              <input
                aria-label="Search inventory items"
                className="mb-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) =>
                  onInventorySearchChange(event.target.value)
                }
                placeholder="Search inventory name, SKU, brand, or manufacturer"
                type="search"
                value={inventorySearch}
              />
              <select
                aria-label="Linked inventory item"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedInventoryItem(
                    inventoryChoices.find(
                      (option) => String(option.id) === value,
                    ) ?? null,
                  );
                  update("inventory_item_id", value);
                }}
                value={form.inventory_item_id}
              >
                <option value="">Not linked</option>
                {inventoryChoices.map((inventoryItem) => (
                  <option key={inventoryItem.id} value={inventoryItem.id}>
                    {inventoryItem.display_name} ({inventoryItem.sku_code})
                  </option>
                ))}
              </select>
              {inventoryLoading ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Searching inventory…
                </span>
              ) : inventoryError ? (
                <span className="mt-1 block text-xs text-destructive">
                  Inventory search is unavailable. The current link is
                  preserved.
                </span>
              ) : (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Search the inventory master; up to 50 matching items are
                  shown.
                </span>
              )}
            </FormField>
            <FormField label="Default unit cost reference">
              <input
                aria-label="Default unit cost reference"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                min="0"
                onChange={(event) =>
                  update("default_unit_cost_reference", event.target.value)
                }
                step="0.01"
                type="number"
                value={form.default_unit_cost_reference}
              />
            </FormField>
            <FormField label="Billing item code">
              <input
                aria-describedby="billing-code-help"
                aria-label="Billing item code"
                className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
                onChange={(event) =>
                  update("billing_item_code", event.target.value)
                }
                placeholder="Owner-supplied code"
                value={form.billing_item_code}
              />
              <span
                id="billing-code-help"
                className="mt-1 block text-xs text-muted-foreground"
              >
                Unmapped usage remains visible in the Unbilled Usage report.
              </span>
            </FormField>
            <FormField label="Reprocessed tariff code">
              <input
                aria-describedby="reused-billing-code-help"
                aria-label="Reprocessed tariff code"
                className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
                onChange={(event) =>
                  update("reused_billing_item_code", event.target.value)
                }
                placeholder="Service-master code for reuse"
                value={form.reused_billing_item_code}
              />
              <span
                id="reused-billing-code-help"
                className="mt-1 block text-xs text-muted-foreground"
              >
                Billed instead of the item code when a reprocessed device is
                used (cycle 1 or later). Leave blank to bill reuse at the item
                code.
              </span>
            </FormField>
            <FormField label="Status">
              <select
                aria-label="Status"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) =>
                  update("status", event.target.value as CathConsumableStatus)
                }
                value={form.status}
              >
                <option value="active">Active</option>
                <option value="retired">Retired</option>
              </select>
            </FormField>
          </div>

          <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:grid-cols-2">
            <ToggleField
              checked={form.is_implant}
              disabled={categoryRequiresImplant}
              description="Captures serial-numbered patient implant usage."
              label="Implant"
              onChange={(checked) =>
                setForm((current) => ({
                  ...current,
                  is_implant: checked,
                  batch_tracked: checked || current.batch_tracked,
                }))
              }
            />
            <ToggleField
              checked={form.batch_tracked}
              disabled={batchTrackingRequired}
              description="Lot number and expiry become mandatory at usage capture."
              label="Batch tracked"
              onChange={(checked) => update("batch_tracked", checked)}
            />
          </div>

          {validationError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {validationError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              className="h-10 rounded-md border border-border px-4 text-sm font-medium hover:bg-muted"
              disabled={submitting}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={submitting}
              type="submit"
            >
              {submitting ? "Saving…" : item ? "Save changes" : "Add item"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function FormField({
  children,
  label,
  required = false,
}: {
  children: React.ReactNode;
  label: string;
  required?: boolean;
}) {
  return (
    <label className="block text-sm font-medium text-foreground">
      <span>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function ToggleField({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-3 ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
    >
      <input
        checked={checked}
        className="mt-1 h-4 w-4 rounded border-input"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}
