"use client";

// PUT /linen-laundry/par-levels — upsert on (tenant_id, ward_id, item_type_id).
// Had no caller before lane L, so linen_ward_par_levels stayed empty and the
// board's "Below par"/"Shortage" tiles could only ever read zero.

import {
  listLinenItemTypes,
  upsertLinenParLevel,
  type LinenParLevel,
} from "@/lib/api/linenLaundry";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { DialogError, Field, Modal, errorMessage, inputClass } from "./helpers";
import { useWardOptions } from "./useWardOptions";

export function ParLevelDialog({
  row,
  onClose,
}: {
  /** Existing board row to edit, or undefined to add a new ward/item pairing. */
  row?: LinenParLevel;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const {
    wards,
    isLoading: wardsLoading,
    error: wardsError,
  } = useWardOptions();
  const itemTypes = useQuery({
    queryKey: ["linen-laundry", "item-types"],
    queryFn: () => listLinenItemTypes({ active: true }),
  });

  const [form, setForm] = useState({
    ward_id: row ? String(row.ward_id) : "",
    item_type_id: row ? String(row.item_type_id) : "",
    par_quantity: String(row?.par_quantity ?? 0),
    actual_quantity: String(row?.actual_quantity ?? 0),
    reorder_threshold: String(row?.reorder_threshold ?? 0),
    notes: "",
  });
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      upsertLinenParLevel({
        ward_id: Number(form.ward_id),
        item_type_id: Number(form.item_type_id),
        par_quantity: Number(form.par_quantity),
        actual_quantity: Number(form.actual_quantity),
        reorder_threshold: Number(form.reorder_threshold),
        notes: form.notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Par level saved");
      qc.invalidateQueries({ queryKey: ["linen-laundry"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(errorMessage(err, "Could not save the par level")),
  });

  const nonNegative = (value: string) =>
    /^\d+$/.test(value.trim()) && Number(value) >= 0;
  const canSave =
    form.ward_id !== "" &&
    form.item_type_id !== "" &&
    nonNegative(form.par_quantity) &&
    nonNegative(form.actual_quantity) &&
    nonNegative(form.reorder_threshold);

  const availableItemTypes = itemTypes.data ?? [];

  return (
    <Modal
      title={row ? `Par level — ${row.ward_name}` : "Set ward par level"}
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
            {save.isPending ? "Saving…" : "Save par level"}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      {wardsError && (
        <DialogError
          message={`Ward list unavailable — ${wardsError}. Par levels are recorded against a ward, so this needs an account that can read the ward list.`}
        />
      )}
      {itemTypes.error instanceof Error && (
        <DialogError message={itemTypes.error.message} />
      )}
      {!itemTypes.isLoading &&
        !itemTypes.error &&
        availableItemTypes.length === 0 && (
          <DialogError message="No active linen item types yet — add one on the Item types tab first." />
        )}

      <Field label="Ward *">
        <select
          aria-label="Ward"
          className={inputClass}
          value={form.ward_id}
          disabled={Boolean(row) || wardsLoading}
          onChange={(e) => setForm((f) => ({ ...f, ward_id: e.target.value }))}
        >
          <option value="">
            {wardsLoading ? "Loading wards…" : "Select a ward"}
          </option>
          {row && !wards.some((ward) => ward.id === row.ward_id) && (
            <option value={String(row.ward_id)}>{row.ward_name}</option>
          )}
          {wards.map((ward) => (
            <option key={ward.id} value={String(ward.id)}>
              {ward.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Linen item *">
        <select
          aria-label="Linen item"
          className={inputClass}
          value={form.item_type_id}
          disabled={Boolean(row)}
          onChange={(e) =>
            setForm((f) => ({ ...f, item_type_id: e.target.value }))
          }
        >
          <option value="">Select an item type</option>
          {row &&
            !availableItemTypes.some((it) => it.id === row.item_type_id) && (
              <option value={String(row.item_type_id)}>
                {row.display_name}
              </option>
            )}
          {availableItemTypes.map((itemType) => (
            <option key={itemType.id} value={String(itemType.id)}>
              {itemType.display_name} ({itemType.item_code})
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Par quantity *">
          <input
            aria-label="Par quantity"
            className={inputClass}
            inputMode="numeric"
            value={form.par_quantity}
            onChange={(e) =>
              setForm((f) => ({ ...f, par_quantity: e.target.value }))
            }
          />
        </Field>
        <Field label="Actual on hand">
          <input
            aria-label="Actual on hand"
            className={inputClass}
            inputMode="numeric"
            value={form.actual_quantity}
            onChange={(e) =>
              setForm((f) => ({ ...f, actual_quantity: e.target.value }))
            }
          />
        </Field>
        <Field label="Reorder at">
          <input
            aria-label="Reorder at"
            className={inputClass}
            inputMode="numeric"
            value={form.reorder_threshold}
            onChange={(e) =>
              setForm((f) => ({ ...f, reorder_threshold: e.target.value }))
            }
          />
        </Field>
      </div>

      <Field
        label="Notes"
        hint="Recording a non-zero count stamps the last-counted time."
      >
        <textarea
          aria-label="Notes"
          className={inputClass}
          rows={2}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </Field>
    </Modal>
  );
}
