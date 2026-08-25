"use client";

// Laundry-cycle write surface. Before lane L, POST /linen-laundry/cycles and
// the five transitions had no caller in any client and no cron wrote
// linen_laundry_cycles, so the board's "Laundry Cycles" table was permanently
// empty in production.
//
// Every transition offered here comes from LINEN_CYCLE_TRANSITIONS, which
// mirrors CYCLE_TRANSITIONS in the backend service and is pinned against it by
// test — a control for an unlisted transition could only ever 409.

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  cancelLinenCycle,
  collectLinenCycle,
  createLinenCycle,
  getLinenCycle,
  listLinenItemTypes,
  reconcileLinenCycle,
  returnLinenCycle,
  sendLinenCycleToLaundry,
  type LinenCycle,
} from "@/lib/api/linenLaundry";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";

import {
  DialogError,
  Field,
  Modal,
  errorMessage,
  humanize,
  inputClass,
} from "./helpers";
import { useWardOptions } from "./useWardOptions";

export type CycleTransition =
  "collected" | "in_laundry" | "returned" | "reconciled" | "cancelled";

const TRANSITION_LABEL: Record<CycleTransition, string> = {
  collected: "Record collection",
  in_laundry: "Send to laundry",
  returned: "Record return",
  reconciled: "Reconcile",
  cancelled: "Cancel cycle",
};

export function transitionLabel(transition: string) {
  return (
    TRANSITION_LABEL[transition as CycleTransition] ?? humanize(transition)
  );
}

/* ── New cycle ──────────────────────────────────────────────────────────── */

export function NewCycleDialog({ onClose }: { onClose: () => void }) {
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

  const [wardId, setWardId] = useState("");
  const [notes, setNotes] = useState("");
  const [planned, setPlanned] = useState<Record<number, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const available = useMemo(() => itemTypes.data ?? [], [itemTypes.data]);
  const items = useMemo(
    () =>
      available
        .map((itemType) => ({
          item_type_id: itemType.id,
          soiled_planned_quantity: Number(planned[itemType.id] ?? ""),
        }))
        .filter(
          (item) =>
            Number.isSafeInteger(item.soiled_planned_quantity) &&
            item.soiled_planned_quantity > 0,
        ),
    [available, planned],
  );

  const create = useMutation({
    mutationFn: () =>
      createLinenCycle({
        ward_id: Number(wardId),
        items,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (cycle) => {
      toast.success(`Cycle ${cycle.cycle_code} created`);
      qc.invalidateQueries({ queryKey: ["linen-laundry"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(errorMessage(err, "Could not create the laundry cycle")),
  });

  const canCreate = wardId !== "" && items.length > 0;

  return (
    <Modal
      title="New laundry cycle"
      onClose={onClose}
      wide
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
            disabled={!canCreate || create.isPending}
            onClick={() => {
              setFailure(null);
              create.mutate();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create cycle"}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      {wardsError && (
        <DialogError
          message={`Ward list unavailable — ${wardsError}. A cycle belongs to a ward, so this needs an account that can read the ward list.`}
        />
      )}
      {itemTypes.error instanceof Error && (
        <DialogError message={itemTypes.error.message} />
      )}
      {!itemTypes.isLoading && !itemTypes.error && available.length === 0 && (
        <DialogError message="No active linen item types yet — add one on the Item types tab first." />
      )}

      <Field label="Ward *">
        <select
          aria-label="Ward"
          className={inputClass}
          value={wardId}
          disabled={wardsLoading}
          onChange={(e) => setWardId(e.target.value)}
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

      {available.length > 0 && (
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Item</th>
                <th className="p-2 text-right">Soiled to collect</th>
              </tr>
            </thead>
            <tbody>
              {available.map((itemType) => (
                <tr key={itemType.id} className="border-t border-border">
                  <td className="p-2">
                    <div className="font-medium">{itemType.display_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {itemType.item_code} · {itemType.unit}
                    </div>
                  </td>
                  <td className="p-2 text-right">
                    <input
                      className={`${inputClass} max-w-24 text-right`}
                      inputMode="numeric"
                      aria-label={`Soiled quantity for ${itemType.display_name}`}
                      value={planned[itemType.id] ?? ""}
                      placeholder="0"
                      onChange={(e) =>
                        setPlanned((prev) => ({
                          ...prev,
                          [itemType.id]: e.target.value,
                        }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Field label="Notes">
        <textarea
          aria-label="Notes"
          className={inputClass}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

/* ── Transitions ────────────────────────────────────────────────────────── */

type CountRow = { clean: string; damaged: string; collected: string };

export function CycleActionDialog({
  cycle,
  transition,
  onClose,
}: {
  cycle: LinenCycle;
  transition: CycleTransition;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const needsItems = transition === "collected" || transition === "returned";

  const detail = useQuery({
    queryKey: ["linen-laundry", "cycle", cycle.id],
    queryFn: () => getLinenCycle(cycle.id),
    enabled: needsItems,
  });

  const [counts, setCounts] = useState<Record<number, CountRow> | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const detailItems = useMemo(() => detail.data?.items ?? [], [detail.data]);
  const rows = useMemo(() => {
    if (!needsItems) return [];
    return detailItems.map((item) => {
      const current = counts?.[item.item_type_id];
      return {
        item,
        clean: current?.clean ?? String(item.soiled_collected_quantity ?? 0),
        damaged: current?.damaged ?? "0",
        collected:
          current?.collected ??
          String(
            transition === "collected"
              ? item.soiled_collected_quantity || item.soiled_planned_quantity
              : item.soiled_collected_quantity,
          ),
      };
    });
  }, [counts, detailItems, needsItems, transition]);

  function patch(itemTypeId: number, field: keyof CountRow, value: string) {
    // `rows` already merges any prior edit over the fetched defaults, so the
    // displayed row IS the current state for the two fields not being edited.
    const displayed = rows.find((row) => row.item.item_type_id === itemTypeId);
    const base: CountRow = {
      clean: displayed?.clean ?? "0",
      damaged: displayed?.damaged ?? "0",
      collected: displayed?.collected ?? "0",
    };
    setCounts((prev) => ({
      ...(prev ?? {}),
      [itemTypeId]: { ...base, [field]: value },
    }));
  }

  const run = useMutation({
    mutationFn: async () => {
      switch (transition) {
        case "collected":
          return collectLinenCycle(cycle.id, {
            items: rows.map((row) => ({
              item_type_id: row.item.item_type_id,
              soiled_collected_quantity: Number(row.collected),
            })),
          });
        case "in_laundry":
          return sendLinenCycleToLaundry(cycle.id);
        case "returned":
          return returnLinenCycle(cycle.id, {
            items: rows.map((row) => ({
              item_type_id: row.item.item_type_id,
              soiled_collected_quantity: Number(row.collected),
              clean_returned_quantity: Number(row.clean),
              damaged_quantity: Number(row.damaged),
            })),
          });
        case "reconciled":
          return reconcileLinenCycle(cycle.id);
        case "cancelled":
          return cancelLinenCycle(cycle.id, {
            reason: reason.trim() || undefined,
          });
        default:
          throw new Error(`Unsupported transition: ${transition}`);
      }
    },
    onSuccess: (updated) => {
      toast.success(
        `${cycle.cycle_code} — ${humanize(updated?.status ?? transition)}`,
      );
      qc.invalidateQueries({ queryKey: ["linen-laundry"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(
        errorMessage(
          err,
          `Could not ${transitionLabel(transition).toLowerCase()}`,
        ),
      ),
  });

  const numeric = (value: string) => /^\d+$/.test(String(value).trim());
  const countsValid =
    !needsItems ||
    (rows.length > 0 &&
      rows.every(
        (row) =>
          numeric(row.collected) &&
          (transition !== "returned" ||
            (numeric(row.clean) && numeric(row.damaged))),
      ));
  const canRun = countsValid && !detail.isLoading && !detail.error;

  return (
    <Modal
      title={`${transitionLabel(transition)} — ${cycle.cycle_code}`}
      onClose={onClose}
      wide={needsItems}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!canRun || run.isPending}
            onClick={() => {
              setFailure(null);
              run.mutate();
            }}
            className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${
              transition === "cancelled"
                ? "bg-rose-600 text-white"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {run.isPending ? "Working…" : transitionLabel(transition)}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      {detail.error instanceof Error && (
        <DialogError message={detail.error.message} />
      )}
      {needsItems && detail.isLoading && (
        <LoadingSpinner label="Loading cycle items" />
      )}

      {needsItems && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Item</th>
                <th className="p-2 text-right">
                  {transition === "collected" ? "Collected" : "Soiled sent"}
                </th>
                {transition === "returned" && (
                  <>
                    <th className="p-2 text-right">Clean returned</th>
                    <th className="p-2 text-right">Damaged</th>
                    <th className="p-2 text-right">Missing</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const missing = Math.max(
                  Number(row.collected || 0) -
                    (Number(row.clean || 0) + Number(row.damaged || 0)),
                  0,
                );
                return (
                  <tr
                    key={row.item.item_type_id}
                    className="border-t border-border"
                  >
                    <td className="p-2">
                      <div className="font-medium">{row.item.display_name}</div>
                      <div className="text-xs text-muted-foreground">
                        planned {row.item.soiled_planned_quantity} ·{" "}
                        {row.item.unit}
                      </div>
                    </td>
                    <td className="p-2 text-right">
                      <input
                        className={`${inputClass} max-w-24 text-right`}
                        inputMode="numeric"
                        aria-label={`Soiled quantity for ${row.item.display_name}`}
                        value={row.collected}
                        onChange={(e) =>
                          patch(
                            row.item.item_type_id,
                            "collected",
                            e.target.value,
                          )
                        }
                      />
                    </td>
                    {transition === "returned" && (
                      <>
                        <td className="p-2 text-right">
                          <input
                            className={`${inputClass} max-w-24 text-right`}
                            inputMode="numeric"
                            aria-label={`Clean returned for ${row.item.display_name}`}
                            value={row.clean}
                            onChange={(e) =>
                              patch(
                                row.item.item_type_id,
                                "clean",
                                e.target.value,
                              )
                            }
                          />
                        </td>
                        <td className="p-2 text-right">
                          <input
                            className={`${inputClass} max-w-24 text-right`}
                            inputMode="numeric"
                            aria-label={`Damaged for ${row.item.display_name}`}
                            value={row.damaged}
                            onChange={(e) =>
                              patch(
                                row.item.item_type_id,
                                "damaged",
                                e.target.value,
                              )
                            }
                          />
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {missing}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {transition === "in_laundry" && (
        <p className="text-sm text-muted-foreground">
          Marks {cycle.cycle_code} as sent to the laundry and stamps the
          dispatch time.
        </p>
      )}

      {transition === "reconciled" && (
        <p className="text-sm text-muted-foreground">
          Closes {cycle.cycle_code} and adjusts each ward par level by the clean
          quantity returned minus the soiled quantity collected. A ward/item
          pairing with no par row yet gets one created at par 0.
        </p>
      )}

      {transition === "cancelled" && (
        <Field label="Cancellation reason">
          <textarea
            aria-label="Cancellation reason"
            className={inputClass}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
    </Modal>
  );
}
