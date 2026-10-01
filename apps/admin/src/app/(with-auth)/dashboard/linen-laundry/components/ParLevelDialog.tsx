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
import { useEffect, useState } from "react";
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
    scopeKey, ready, changed, isFetching, hasNextPage,
    isFetchingNextPage, fetchNextPage, validateSelection,
  } = useWardOptions(onClose);
  const itemTypes = useQuery({
    queryKey: ["linen-laundry", "item-types", scopeKey],
    queryFn: () => listLinenItemTypes({ active: true }),
    enabled: ready,
    gcTime: 0,
  });

  const [form, setForm] = useState({
    ward_id: "",
    item_type_id: row ? String(row.item_type_id) : "",
    par_quantity: String(row?.par_quantity ?? 0),
    actual_quantity: String(row?.actual_quantity ?? 0),
    reorder_threshold: String(row?.reorder_threshold ?? 0),
    notes: "",
  });
  const [failure, setFailure] = useState<string | null>(null);
  const selectedWardId = row ? String(row.ward_id) : form.ward_id;
  const wardAvailable = wards.some(ward => ward.id === Number(selectedWardId));

  useEffect(() => {
    if (!row && !isFetching && form.ward_id && (wardsError
      || (!hasNextPage && !wardsLoading && !wards.some(ward => ward.id === Number(form.ward_id))))) {
      setForm(value => ({ ...value, ward_id: "" }));
    }
  }, [row, isFetching, hasNextPage, wardsLoading, wardsError, wards, form.ward_id]);

  const save = useMutation({
    mutationFn: async () => {
      try {
        await validateSelection(Number(selectedWardId));
      } catch (err) {
        if (row) {
          throw new Error("The ward could not be confirmed. Refresh the ward directory before saving.");
        }
        setForm(value => ({ ...value, ward_id: "" }));
        throw err;
      }
      return upsertLinenParLevel({
        ward_id: Number(selectedWardId),
        item_type_id: Number(form.item_type_id),
        par_quantity: Number(form.par_quantity),
        actual_quantity: Number(form.actual_quantity),
        reorder_threshold: Number(form.reorder_threshold),
        notes: form.notes.trim() || undefined,
      });
    },
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
    ready && !isFetching && !wardsError &&
    wardAvailable &&
    form.item_type_id !== "" &&
    nonNegative(form.par_quantity) &&
    nonNegative(form.actual_quantity) &&
    nonNegative(form.reorder_threshold);

  const availableItemTypes = itemTypes.data ?? [];

  if (changed) return null;

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
          message={`Ward directory unavailable — ${wardsError}`}
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
          value={wardAvailable ? selectedWardId : ""}
          disabled={Boolean(row) || !ready || wardsLoading || Boolean(wardsError) || save.isPending}
          onChange={(e) => setForm((f) => ({ ...f, ward_id: e.target.value }))}
        >
          <option value="">
            {wardsLoading ? "Loading wards…" : "Select a ward"}
          </option>
          {wards.map((ward) => (
            <option key={ward.id} value={String(ward.id)}>
              {ward.name}
            </option>
          ))}
        </select>
      </Field>

      {row && !wardsLoading && !wardAvailable && (
        <button type="button" disabled={!ready || isFetching || save.isPending}
          onClick={async () => {
            setFailure(null);
            try {
              await validateSelection(row.ward_id);
            } catch {
              setFailure("The ward could not be confirmed. Refresh the ward directory before saving.");
            }
          }} className="text-sm text-primary">
          {isFetching ? "Refreshing wards…" : "Refresh ward directory"}
        </button>
      )}
      {!wardsLoading && !wardsError && wards.length === 0 && (
        <p className="text-sm text-muted-foreground">No wards are available.</p>
      )}
      {hasNextPage && (
        <button type="button" disabled={isFetchingNextPage || save.isPending}
          onClick={() => void fetchNextPage()} className="text-sm text-primary">
          {isFetchingNextPage ? "Loading wards…" : "Load more wards"}
        </button>
      )}
      {row && !wardsLoading && !hasNextPage && !wardsError
        && !wards.some(ward => ward.id === row.ward_id) && (
        <DialogError message="This historical ward is no longer available for selection." />
      )}

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
