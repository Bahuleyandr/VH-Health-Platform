"use client";

// Cath device-reuse governance: the blood-borne marker rules and the
// per-category reprocessing policy.
//
// Served by /api/v1/cath-reprocessing (its own mount, audience
// CATH_REPROCESSING_POLICY_ROUTE_ROLES — quality, infection control, admin),
// not by the admin cath-consumables barrel. Both PUTs are mounted with
// `requireIdempotencyKey({ required: true, scope: 'cath_reprocessing_policy' })`
// so each carries an attempt-scoped key minted here.
//
// `reset()` runs on SUCCESS ONLY, as at every other call site in this app. A
// failed save deliberately KEEPS its key: idempotencyMiddleware caches a 4xx
// outcome and deletes the claim on a 5xx, so pressing Save again either replays
// the recorded refusal or runs the PUT exactly once. Re-minting on error throws
// that away — a request that timed out on the wire but committed on the server
// would be written a second time under a key the server has never seen.
//
// Two rules this screen enforces client-side rather than discovering as a 400:
//
//   * Implant categories can never be reprocessable
//     (CATH_REPROCESSING_IMPLANT_FORBIDDEN), so their toggle is disabled.
//   * A reprocessable category needs max_cycles AND at least one allowed cycle
//     type (CATH_REPROCESSING_POLICY_INCOMPLETE). The backend rejects the whole
//     PUT on the first offender, so an unguarded Save would lose the operator's
//     edits to all nine rows over one blank cell.
//
// The save always sends ALL nine categories. `upsertCategoryPolicies` upserts
// the set it receives and deletes nothing, so an omitted category would keep
// its old row while the screen claimed to have saved.
//
// Each section is gated on ITS OWN query resolving. Editing on top of an empty
// or failed read is not an empty screen — it is a full nine-category PUT built
// from `defaultPolicy`, i.e. a silent wipe of every policy the read never
// delivered. Same for the settings PUT, which would post the form's own
// defaults over whatever the tenant has.
//
// `inputClass` and `errorText` below duplicate `inputClass`/`errorMessage` in
// cssd/components/helpers.tsx and are deliberately NOT imported from there: the
// CSSD console's input uses the semantic `border-border`/`bg-background`
// tokens, this console's the explicit gray palette, so the strings are not the
// same value; and pulling the one-line `errorMessage` across would drag that
// module's Modal, StatusPill and lucide icon into this bundle for it.

import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  CATH_CATEGORIES,
  CATH_DEVICE_CYCLE_TYPES,
  IMPLANT_CATEGORIES,
  getCathReprocessingSettings,
  listCathReprocessingPolicies,
  updateCathReprocessingPolicies,
  updateCathReprocessingSettings,
  type CathCategory,
  type CathDeviceCycleType,
  type CathReprocessingPolicyInput,
  type CathReprocessingSettings,
} from "@/lib/api/cathDevices";
import { payloadIdentity } from "@/lib/idempotencyKey";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900";

const panelClass =
  "rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300";

const SETTINGS_QUERY_KEY = ["cath", "reprocessing", "settings"] as const;
const POLICIES_QUERY_KEY = ["cath", "reprocessing", "policies"] as const;

/**
 * The settings form allows a null `serology_validity_days` — the state a
 * cleared number box is actually in. Coercing "" to 0 would post a validity
 * window of zero days, under which every serology result is instantly stale.
 */
type SettingsForm = Omit<CathReprocessingSettings, "serology_validity_days"> & {
  serology_validity_days: number | null;
};

/** "closure_device" -> "Closure device", for aria-labels and the row header. */
function categoryLabel(category: string) {
  const words = category.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "dry_heat" -> "dry heat". Read inside a sentence, so it stays lowercase. */
function cycleTypeLabel(type: string) {
  return type.replace(/_/g, " ");
}

function defaultPolicy(category: CathCategory): CathReprocessingPolicyInput {
  return {
    category,
    reprocessable: false,
    max_cycles: null,
    allowed_cycle_types: [],
    function_check_required: false,
  };
}

function errorText(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function ReprocessingPolicyTab() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: getCathReprocessingSettings,
    // A focus refetch mid-edit would reseed the form from the server and throw
    // the operator's unsaved edits away. The `dirty` guards below already stop
    // that, but not asking is cheaper than guarding.
    refetchOnWindowFocus: false,
  });
  const policiesQuery = useQuery({
    queryKey: POLICIES_QUERY_KEY,
    queryFn: listCathReprocessingPolicies,
    refetchOnWindowFocus: false,
  });

  const [settings, setSettings] = useState<SettingsForm | null>(null);
  const [policies, setPolicies] = useState<CathReprocessingPolicyInput[]>([]);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [policiesDirty, setPoliciesDirty] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const settingsKey = useIdempotencyKey("cath-reprocessing-policy");
  const policiesKey = useIdempotencyKey("cath-reprocessing-policy");

  useEffect(() => {
    // Reseed only while the section is untouched. A refetch that lands under an
    // operator mid-edit must not silently revert what they typed.
    if (settingsQuery.data && !settingsDirty) {
      setSettings(settingsQuery.data.settings);
    }
  }, [settingsQuery.data, settingsDirty]);

  useEffect(() => {
    // The backend always answers with all nine categories, but seeding from
    // whatever arrived keeps the editor honest if that ever changes.
    if (policiesQuery.data && !policiesDirty) {
      setPolicies(
        policiesQuery.data.policies.map((policy) => ({
          category: policy.category,
          reprocessable: policy.reprocessable,
          max_cycles: policy.max_cycles,
          allowed_cycle_types: policy.allowed_cycle_types,
          function_check_required: policy.function_check_required,
        })),
      );
    }
  }, [policiesQuery.data, policiesDirty]);

  const saveSettings = useMutation({
    mutationFn: () => {
      if (!settings) throw new Error("Settings are still loading");
      const validityDays = settings.serology_validity_days;
      if (validityDays == null) {
        throw new Error("Serology validity (days) is required");
      }
      const body = {
        reactive_patient_rule: settings.reactive_patient_rule,
        unknown_serology_rule: settings.unknown_serology_rule,
        serology_validity_days: validityDays,
      };
      return updateCathReprocessingSettings(
        body,
        settingsKey.keyFor(payloadIdentity({ kind: "settings", body })),
      );
    },
    onSuccess: (data) => {
      settingsKey.reset();
      setSettingsError(null);
      setSettingsDirty(false);
      toast.success("Reprocessing settings saved");
      // Seed the cache with what the PUT returned BEFORE invalidating. Clearing
      // `settingsDirty` re-arms the reseed effect, and the only thing in the
      // cache until the invalidate's refetch lands is the pre-save read — so
      // without this the form snaps back to the OLD settings the moment the
      // save succeeds, and a second Save writes those back over the new ones.
      qc.setQueryData(SETTINGS_QUERY_KEY, data);
      void qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
    onError: (err: unknown) => {
      // No reset() — the retry must carry the same key (see the header).
      setSettingsError(errorText(err, "Could not save the settings"));
    },
  });

  const savePolicies = useMutation({
    mutationFn: (body: CathReprocessingPolicyInput[]) =>
      updateCathReprocessingPolicies(
        body,
        policiesKey.keyFor(payloadIdentity({ kind: "policies", body })),
      ),
    onSuccess: (data) => {
      policiesKey.reset();
      setPolicyError(null);
      setPoliciesDirty(false);
      toast.success("Category policies saved");
      // Seed the cache with what the PUT returned BEFORE invalidating. Clearing
      // `policiesDirty` re-arms the reseed effect, and the only thing in the
      // cache until the invalidate's refetch lands is the pre-save read — so
      // without this the grid snaps back to the OLD policies the moment the
      // save succeeds, and a second Save writes those back over the new ones.
      qc.setQueryData(POLICIES_QUERY_KEY, data);
      void qc.invalidateQueries({ queryKey: POLICIES_QUERY_KEY });
    },
    onError: (err: unknown) => {
      // No reset() — the retry must carry the same key (see the header).
      setPolicyError(errorText(err, "Could not save the category policies"));
    },
  });

  function updateSettings(patch: Partial<SettingsForm>) {
    setSettingsDirty(true);
    setSettings((current) => (current ? { ...current, ...patch } : current));
  }

  function policyFor(category: CathCategory): CathReprocessingPolicyInput {
    return (
      policies.find((policy) => policy.category === category) ??
      defaultPolicy(category)
    );
  }

  function updatePolicy(
    category: CathCategory,
    patch: Partial<CathReprocessingPolicyInput>,
  ) {
    setPoliciesDirty(true);
    setPolicies((current) =>
      current.some((policy) => policy.category === category)
        ? current.map((policy) =>
            policy.category === category ? { ...policy, ...patch } : policy,
          )
        : [...current, { ...defaultPolicy(category), ...patch }],
    );
  }

  function submitPolicies() {
    // Send the full set, in the canonical category order, so the payload does
    // not depend on which rows the operator happened to touch.
    const body = CATH_CATEGORIES.map((category) => policyFor(category));
    const incomplete = body.filter(
      (policy) =>
        policy.reprocessable &&
        (policy.max_cycles == null ||
          (policy.allowed_cycle_types ?? []).length === 0),
    );
    if (incomplete.length > 0) {
      setPolicyError(
        `A reprocessable category needs a max-cycle count and at least one cycle type: ${incomplete
          .map((policy) => policy.category.replace(/_/g, " "))
          .join(", ")}.`,
      );
      return;
    }
    setPolicyError(null);
    savePolicies.mutate(body);
  }

  const settingsReady = settingsQuery.isSuccess && settings !== null;
  const validityMissing = settings?.serology_validity_days == null;

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="text-sm font-semibold">Blood-borne marker rules</h2>
        {settingsQuery.error instanceof Error ? (
          <p className={panelClass}>{settingsQuery.error.message}</p>
        ) : !settingsReady ? (
          <p className="text-sm text-gray-500">Loading reprocessing policy…</p>
        ) : (
          <>
            <p className="text-xs text-gray-500">
              {settings.configured
                ? "Reviewed by an owner; the defaults below are in force."
                : "Not yet reviewed by an owner — the platform defaults are in force until they are saved here."}
            </p>
            {settingsError ? (
              <p className={panelClass}>{settingsError}</p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-xs">
                Reactive patient
                <select
                  aria-label="Reactive patient rule"
                  className={inputClass}
                  value={settings.reactive_patient_rule}
                  onChange={(e) =>
                    updateSettings({
                      reactive_patient_rule: e.target
                        .value as CathReprocessingSettings["reactive_patient_rule"],
                    })
                  }
                >
                  <option value="discard">Discard devices (default)</option>
                  <option value="override_allowed">
                    Reprocess with acknowledged override
                  </option>
                </select>
              </label>
              <label className="block text-xs">
                Serology unknown
                <select
                  aria-label="Unknown serology rule"
                  className={inputClass}
                  value={settings.unknown_serology_rule}
                  onChange={(e) =>
                    updateSettings({
                      unknown_serology_rule: e.target
                        .value as CathReprocessingSettings["unknown_serology_rule"],
                    })
                  }
                >
                  <option value="warn">
                    Warn and require acknowledgement (default)
                  </option>
                  <option value="block_return">
                    Block until serology is recorded
                  </option>
                </select>
              </label>
              <label className="block text-xs">
                Serology validity (days)
                <input
                  aria-label="Serology validity days"
                  type="number"
                  min={1}
                  max={365}
                  className={inputClass}
                  value={settings.serology_validity_days ?? ""}
                  onChange={(e) =>
                    updateSettings({
                      // "" stays null rather than becoming 0, which would mean
                      // every serology result is stale the moment it is filed.
                      serology_validity_days:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            {validityMissing ? (
              <p className="text-xs text-rose-700 dark:text-rose-300">
                Enter a serology validity window (1–365 days) before saving.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => saveSettings.mutate()}
              disabled={saveSettings.isPending || validityMissing}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saveSettings.isPending ? "Saving…" : "Save settings"}
            </button>
          </>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="text-sm font-semibold">Reprocessable categories</h2>
        {policiesQuery.error instanceof Error ? (
          <p className={panelClass}>{policiesQuery.error.message}</p>
        ) : !policiesQuery.isSuccess ? (
          <p className="text-sm text-gray-500">Loading category policies…</p>
        ) : (
          <>
            <p className="text-xs text-gray-500">
              Implant categories can never be reprocessed. Max cycles is the
              number of reprocessing cycles a device may undergo, so a device is
              used on at most max cycles + 1 patients.
            </p>
            {policyError ? <p className={panelClass}>{policyError}</p> : null}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-gray-500">
                  <tr>
                    <th className="p-2">Category</th>
                    <th className="p-2">Reprocessable</th>
                    <th className="p-2">Max cycles</th>
                    <th className="p-2">Cycle types</th>
                    <th className="p-2">Function check</th>
                  </tr>
                </thead>
                <tbody>
                  {CATH_CATEGORIES.map((category) => {
                    const policy = policyFor(category);
                    const implant = IMPLANT_CATEGORIES.has(category);
                    const cycleTypes = policy.allowed_cycle_types ?? [];
                    const label = categoryLabel(category);
                    return (
                      <tr
                        key={category}
                        className="border-t border-gray-200 dark:border-gray-700"
                      >
                        <td className="p-2">{label}</td>
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`${label} reprocessable`}
                            disabled={implant}
                            checked={policy.reprocessable}
                            onChange={(e) =>
                              updatePolicy(category, {
                                reprocessable: e.target.checked,
                              })
                            }
                          />
                          {implant ? (
                            <span className="ml-2 text-xs text-gray-500">
                              implant
                            </span>
                          ) : null}
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            min={1}
                            max={50}
                            aria-label={`${label} max cycles`}
                            className={inputClass}
                            disabled={!policy.reprocessable}
                            value={policy.max_cycles ?? ""}
                            onChange={(e) =>
                              updatePolicy(category, {
                                max_cycles:
                                  e.target.value === ""
                                    ? null
                                    : Number(e.target.value),
                              })
                            }
                          />
                        </td>
                        <td className="p-2">
                          <div className="flex flex-wrap gap-2">
                            {CATH_DEVICE_CYCLE_TYPES.map((type) => (
                              <label
                                key={type}
                                className="flex items-center gap-1 text-xs"
                              >
                                <input
                                  type="checkbox"
                                  aria-label={`${label} allows ${cycleTypeLabel(type)}`}
                                  disabled={!policy.reprocessable}
                                  checked={cycleTypes.includes(type)}
                                  onChange={(e) =>
                                    updatePolicy(category, {
                                      allowed_cycle_types: e.target.checked
                                        ? [
                                            ...new Set<CathDeviceCycleType>([
                                              ...cycleTypes,
                                              type,
                                            ]),
                                          ]
                                        : cycleTypes.filter(
                                            (existing) => existing !== type,
                                          ),
                                    })
                                  }
                                />
                                {cycleTypeLabel(type)}
                              </label>
                            ))}
                          </div>
                        </td>
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`${label} function check required`}
                            disabled={!policy.reprocessable}
                            checked={policy.function_check_required ?? false}
                            onChange={(e) =>
                              updatePolicy(category, {
                                function_check_required: e.target.checked,
                              })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              onClick={submitPolicies}
              disabled={savePolicies.isPending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {savePolicies.isPending ? "Saving…" : "Save category policies"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
