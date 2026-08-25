"use client";

// Linen item-type master. Until lane L nothing in the product called
// POST /linen-laundry/item-types, so linen_item_types was always empty — which
// in turn made par levels and laundry cycles impossible to create, because both
// take an item_type_id. This tab is the entry point of that chain.

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  LINEN_ITEM_CATEGORIES,
  listLinenItemTypes,
  upsertLinenItemType,
  type LinenItemType,
} from "@/lib/api/linenLaundry";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import {
  DialogError,
  Field,
  Modal,
  errorMessage,
  fmtDate,
  humanize,
  inputClass,
} from "./helpers";

export function ItemTypesTab() {
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; item: LinenItemType } | null
  >(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["linen-laundry", "item-types"],
    queryFn: () => listLinenItemTypes(),
  });

  const items = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {items.length} item type{items.length === 1 ? "" : "s"} configured.
          Par levels and laundry cycles are recorded against these.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setDialog({ mode: "create" })}
            className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New item type
          </button>
        </div>
      </div>

      {isLoading && <LoadingSpinner label="Loading linen item types" />}

      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error.message}
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="rounded-lg border border-border">
          <EmptyState
            title="No linen item types configured"
            description="Add bed sheets, gowns, OT drapes and the rest before setting ward par levels."
          />
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-3 text-left">Code</th>
                <th className="p-3 text-left">Name</th>
                <th className="p-3 text-left">Category</th>
                <th className="p-3 text-left">Unit</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Updated</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-border">
                  <td className="p-3 font-mono text-xs">{item.item_code}</td>
                  <td className="p-3 font-medium">{item.display_name}</td>
                  <td className="p-3 capitalize">{humanize(item.category)}</td>
                  <td className="p-3">{item.unit}</td>
                  <td className="p-3">
                    <span
                      className={`rounded px-2 py-1 text-xs ${
                        item.active
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "bg-slate-500/15 text-slate-700 dark:text-slate-300"
                      }`}
                    >
                      {item.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="p-3 text-xs">{fmtDate(item.updated_at)}</td>
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => setDialog({ mode: "edit", item })}
                      className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <ItemTypeDialog
          item={dialog.mode === "edit" ? dialog.item : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function ItemTypeDialog({
  item,
  onClose,
}: {
  item?: LinenItemType;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    item_code: item?.item_code ?? "",
    display_name: item?.display_name ?? "",
    category: item?.category ?? "bed_linen",
    unit: item?.unit ?? "piece",
    active: item?.active ?? true,
  });
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      upsertLinenItemType({
        item_code: form.item_code.trim(),
        display_name: form.display_name.trim(),
        category: form.category,
        unit: form.unit.trim() || "piece",
        active: form.active,
      }),
    onSuccess: (saved) => {
      toast.success(`Saved ${saved.display_name}`);
      qc.invalidateQueries({ queryKey: ["linen-laundry"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(errorMessage(err, "Could not save the item type")),
  });

  const canSave =
    form.item_code.trim().length > 0 && form.display_name.trim().length > 0;

  return (
    <Modal
      title={item ? "Edit linen item type" : "New linen item type"}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave || save.isPending}
            onClick={() => {
              setFailure(null);
              save.mutate();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      <Field
        label="Item code *"
        hint={
          item
            ? "The code identifies the item type — changing it creates a new one instead of renaming this."
            : "Stored upper-cased; unique per hospital."
        }
      >
        <input
          aria-label="Item code"
          className={inputClass}
          value={form.item_code}
          disabled={Boolean(item)}
          placeholder="e.g. SHEET-STD"
          onChange={(e) =>
            setForm((f) => ({ ...f, item_code: e.target.value }))
          }
        />
      </Field>
      <Field label="Display name *">
        <input
          aria-label="Display name"
          className={inputClass}
          value={form.display_name}
          placeholder="e.g. Standard bed sheet"
          onChange={(e) =>
            setForm((f) => ({ ...f, display_name: e.target.value }))
          }
        />
      </Field>
      <Field label="Category">
        <select
          aria-label="Category"
          className={inputClass}
          value={form.category}
          onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
        >
          {LINEN_ITEM_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {humanize(category)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Unit">
        <input
          aria-label="Unit"
          className={inputClass}
          value={form.unit}
          placeholder="piece"
          onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Active"
          checked={form.active}
          onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
        />
        Active
      </label>
    </Modal>
  );
}
