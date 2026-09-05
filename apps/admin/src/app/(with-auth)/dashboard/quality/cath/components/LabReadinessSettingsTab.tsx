"use client";

// The tenant's pre-cath lab checklist policy: which analytes the labs check
// requires, how long a result stays fresh, whether automation may tick the
// check itself, and whether an outside report satisfies an item.
//
// Served by PUT/GET /api/v1/cath-reprocessing/lab-readiness-settings — the
// device-reuse GOVERNANCE mount, whose audience (quality, infection control,
// platform admin) is the one that owns this decision. It is deliberately not
// on the admin cath-consumables barrel, whose ADMIN_ROUTE_ROLES can never
// admit those officers. The PUT is mounted with
// `requireIdempotencyKey({ required: true, scope: 'cath_reprocessing_policy' })`
// — the same scope as the two sibling PUTs edited from this screen — so the
// save carries an attempt-scoped key minted here, exactly as
// ReprocessingPolicyTab does.
//
// `reset()` runs on SUCCESS ONLY, as everywhere else in this app: a failed
// save keeps its key so pressing Save again replays the recorded refusal (4xx
// is cached) or runs the PUT exactly once (5xx deletes the claim). Re-minting
// on error is what lets a request that timed out on the wire but committed on
// the server be written a second time.
//
// Three things this screen enforces rather than discovering as a 400 or a
// silent overwrite:
//
//   * `required_items` may not be empty (CATH_LAB_READINESS_ITEMS_EMPTY). The
//     answer to "we do not check labs for this case" is the case's own
//     not-required flag, not a tenant policy that requires nothing.
//   * The PUT is a whole-policy REPLACEMENT: `upsertReadinessSettings` writes
//     an omitted field back at its compiled-in default, so the save always
//     sends all four fields. Posting only the field that changed would reset
//     the other three.
//   * The form is gated on its own query resolving. Editing on top of an empty
//     or failed read is not an empty screen — it is a four-field PUT built
//     from this component's own defaults, i.e. a silent overwrite of whatever
//     the tenant has.
//
// `inputClass` and `panelClass` mirror ReprocessingPolicyTab's so the two tabs
// on this page match; see that file's header for why they are not imported
// from the CSSD console's helpers.

import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  CATH_LAB_READINESS_ITEMS,
  CATH_LAB_READINESS_ITEM_LABELS,
  CATH_LAB_READINESS_SEROLOGY_ITEMS,
  getCathLabReadinessSettings,
  updateCathLabReadinessSettings,
  type CathLabReadinessItem,
  type CathLabReadinessSettings,
} from "@/lib/api/cathDevices";
import { payloadIdentity } from "@/lib/idempotencyKey";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900";

const panelClass =
  "rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300";

const LAB_READINESS_QUERY_KEY = ["cath", "lab-readiness"] as const;

/**
 * A cleared number box is null, not 0. Coercing "" to 0 would post a validity
 * window of zero days, under which every result is stale the moment it is
 * filed — and 0 is outside the schema's 1–365 anyway, so it would be a 400
 * that reads like a server fault.
 */
type LabReadinessForm = {
  required_items: CathLabReadinessItem[];
  lab_validity_days: number | null;
  auto_pass: boolean;
  external_results_count: boolean;
};

function errorText(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

function toForm(settings: CathLabReadinessSettings): LabReadinessForm {
  return {
    // Keep the canonical checklist order rather than whatever order the row
    // was written in, so the payload identity (and the key it mints) does not
    // change just because the server echoed a different ordering.
    required_items: CATH_LAB_READINESS_ITEMS.filter((item) =>
      settings.required_items.includes(item),
    ),
    lab_validity_days: settings.lab_validity_days,
    auto_pass: settings.auto_pass,
    external_results_count: settings.external_results_count,
  };
}

export default function LabReadinessSettingsTab() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: LAB_READINESS_QUERY_KEY,
    queryFn: getCathLabReadinessSettings,
    // A focus refetch mid-edit would reseed the form from the server and throw
    // the operator's unsaved edits away.
    refetchOnWindowFocus: false,
  });

  const [form, setForm] = useState<LabReadinessForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const settingsKey = useIdempotencyKey("cath-reprocessing-policy");

  useEffect(() => {
    // Reseed only while the form is untouched: a refetch landing under an
    // operator mid-edit must not silently revert what they typed.
    if (settingsQuery.data && !dirty) {
      setForm(toForm(settingsQuery.data.settings));
    }
  }, [settingsQuery.data, dirty]);

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error("Lab readiness settings are still loading");
      const validityDays = form.lab_validity_days;
      if (validityDays == null) {
        throw new Error("Lab validity (days) is required");
      }
      if (form.required_items.length === 0) {
        throw new Error(
          "At least one lab item must be required; mark the labs check not required on the case instead",
        );
      }
      // All four fields, always — the PUT replaces the policy wholesale.
      const body = {
        required_items: form.required_items,
        lab_validity_days: validityDays,
        auto_pass: form.auto_pass,
        external_results_count: form.external_results_count,
      };
      return updateCathLabReadinessSettings(
        body,
        settingsKey.keyFor(payloadIdentity({ kind: "lab-readiness", body })),
      );
    },
    onSuccess: () => {
      settingsKey.reset();
      setSaveError(null);
      setDirty(false);
      toast.success("Lab readiness settings saved");
      void qc.invalidateQueries({ queryKey: LAB_READINESS_QUERY_KEY });
    },
    onError: (err: unknown) => {
      // No reset() — the retry must carry the same key (see the header).
      const message = errorText(
        err,
        "Could not save the lab readiness settings",
      );
      setSaveError(message);
      toast.error(message);
    },
  });

  function update(patch: Partial<LabReadinessForm>) {
    setDirty(true);
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  function toggleItem(item: CathLabReadinessItem, required: boolean) {
    if (!form) return;
    update({
      required_items: required
        ? CATH_LAB_READINESS_ITEMS.filter(
            (code) => code === item || form.required_items.includes(code),
          )
        : form.required_items.filter((code) => code !== item),
    });
  }

  const ready = settingsQuery.isSuccess && form !== null;
  const validityMissing = form?.lab_validity_days == null;
  const noItems = (form?.required_items.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="text-sm font-semibold">Pre-cath lab readiness</h2>
        {settingsQuery.error instanceof Error ? (
          <p className={panelClass}>{settingsQuery.error.message}</p>
        ) : !ready ? (
          <p className="text-sm text-gray-500">
            Loading lab readiness settings…
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500">
              {settingsQuery.data?.settings.configured
                ? "Set by this tenant; the policy below is in force."
                : "Not yet set by this tenant — the platform defaults are in force until they are saved here."}
            </p>
            {saveError ? <p className={panelClass}>{saveError}</p> : null}

            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                Required items
              </h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {CATH_LAB_READINESS_ITEMS.map((item) => {
                  const label = CATH_LAB_READINESS_ITEM_LABELS[item];
                  return (
                    <label
                      key={item}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Require ${label}`}
                        checked={form.required_items.includes(item)}
                        onChange={(e) => toggleItem(item, e.target.checked)}
                      />
                      {label}
                      {CATH_LAB_READINESS_SEROLOGY_ITEMS.has(item) ? (
                        <span className="text-xs text-gray-500">
                          (serology)
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500">
                Serology items (HIV, HBsAg, HCV) are judged against the
                serology validity window on the Reprocessing policy tab, not
                the window below — one tenant answer to how long a blood-borne
                marker result is good for.
              </p>
              {noItems ? (
                <p className="text-xs text-rose-700 dark:text-rose-300">
                  At least one item must be required. To skip labs for a
                  particular case, mark that case&apos;s labs check not
                  required instead.
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-xs">
                Lab validity (days)
                <input
                  aria-label="Lab validity days"
                  type="number"
                  min={1}
                  max={365}
                  className={inputClass}
                  value={form.lab_validity_days ?? ""}
                  onChange={(e) =>
                    update({
                      // "" stays null rather than becoming 0, which would mean
                      // every result is stale the moment it is filed.
                      lab_validity_days:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            {validityMissing ? (
              <p className="text-xs text-rose-700 dark:text-rose-300">
                Enter a lab validity window (1–365 days) before saving.
              </p>
            ) : null}

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="Auto-pass labs check"
                  checked={form.auto_pass}
                  onChange={(e) => update({ auto_pass: e.target.checked })}
                />
                Auto-pass the labs check when every required item is in
              </label>
              <p className="text-xs text-gray-500">
                A critical value never blocks; it shows a warning beside the
                tick. Switching auto-pass off stops automation making new
                assertions, but it still retracts a tick it made itself when an
                item goes missing again.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="External results count"
                  checked={form.external_results_count}
                  onChange={(e) =>
                    update({ external_results_count: e.target.checked })
                  }
                />
                Outside reports satisfy an item
              </label>
              <p className="text-xs text-gray-500">
                With this off, a result recorded from a patient&apos;s outside
                report is still shown on the case but does not satisfy the
                check on its own.
              </p>
            </div>

            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || validityMissing || noItems}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save lab readiness settings"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
