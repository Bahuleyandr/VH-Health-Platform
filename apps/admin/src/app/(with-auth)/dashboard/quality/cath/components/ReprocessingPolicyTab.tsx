"use client";

// Cath device-reuse governance: the blood-borne marker rules and the
// per-category reprocessing policy.
//
// Served by /api/v1/cath-reprocessing (its own mount, audience
// CATH_REPROCESSING_POLICY_ROUTE_ROLES — quality, infection control, admin),
// not by the admin cath-consumables barrel. Both PUTs are mounted with
// `requireIdempotencyKey({ required: true, scope: 'cath_reprocessing_policy' })`
// so each carries an attempt-scoped key minted here and reset once the save
// settles.
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

const REPROCESSING_QUERY_KEY = ["cath", "reprocessing"] as const;

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
    queryKey: [...REPROCESSING_QUERY_KEY, "settings"],
    queryFn: getCathReprocessingSettings,
  });
  const policiesQuery = useQuery({
    queryKey: [...REPROCESSING_QUERY_KEY, "policies"],
    queryFn: listCathReprocessingPolicies,
  });

  const [settings, setSettings] = useState<CathReprocessingSettings | null>(
    null,
  );
  const [policies, setPolicies] = useState<CathReprocessingPolicyInput[]>([]);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const settingsKey = useIdempotencyKey("cath-reprocessing-policy");
  const policiesKey = useIdempotencyKey("cath-reprocessing-policy");

  useEffect(() => {
    if (settingsQuery.data) setSettings(settingsQuery.data.settings);
  }, [settingsQuery.data]);

  useEffect(() => {
    // The backend always answers with all nine categories, but seeding from
    // whatever arrived keeps the editor honest if that ever changes.
    if (policiesQuery.data) {
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
  }, [policiesQuery.data]);

  const saveSettings = useMutation({
    mutationFn: () => {
      if (!settings) throw new Error("Settings are still loading");
      const body = {
        reactive_patient_rule: settings.reactive_patient_rule,
        unknown_serology_rule: settings.unknown_serology_rule,
        serology_validity_days: settings.serology_validity_days,
      };
      return updateCathReprocessingSettings(
        body,
        settingsKey.keyFor(payloadIdentity({ kind: "settings", body })),
      );
    },
    onSuccess: () => {
      settingsKey.reset();
      setSettingsError(null);
      toast.success("Reprocessing settings saved");
      void qc.invalidateQueries({ queryKey: REPROCESSING_QUERY_KEY });
    },
    onError: (err: unknown) => {
      settingsKey.reset();
      setSettingsError(errorText(err, "Could not save the settings"));
    },
  });

  const savePolicies = useMutation({
    mutationFn: (body: CathReprocessingPolicyInput[]) =>
      updateCathReprocessingPolicies(
        body,
        policiesKey.keyFor(payloadIdentity({ kind: "policies", body })),
      ),
    onSuccess: () => {
      policiesKey.reset();
      setPolicyError(null);
      toast.success("Category policies saved");
      void qc.invalidateQueries({ queryKey: REPROCESSING_QUERY_KEY });
    },
    onError: (err: unknown) => {
      policiesKey.reset();
      setPolicyError(errorText(err, "Could not save the category policies"));
    },
  });

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

  if (settingsQuery.error instanceof Error) {
    return (
      <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300">
        {settingsQuery.error.message}
      </p>
    );
  }

  if (!settings) {
    return (
      <p className="text-sm text-gray-500">Loading reprocessing policy…</p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="text-sm font-semibold">Blood-borne marker rules</h2>
        <p className="text-xs text-gray-500">
          {settings.configured
            ? "Reviewed by an owner; the defaults below are in force."
            : "Not yet reviewed by an owner — the platform defaults are in force until they are saved here."}
        </p>
        {settingsError ? (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
            {settingsError}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-xs">
            Reactive patient
            <select
              aria-label="Reactive patient rule"
              className={inputClass}
              value={settings.reactive_patient_rule}
              onChange={(e) =>
                setSettings({
                  ...settings,
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
                setSettings({
                  ...settings,
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
              value={settings.serology_validity_days}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  serology_validity_days: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => saveSettings.mutate()}
          disabled={saveSettings.isPending}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saveSettings.isPending ? "Saving…" : "Save settings"}
        </button>
      </section>

      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="text-sm font-semibold">Reprocessable categories</h2>
        <p className="text-xs text-gray-500">
          Implant categories can never be reprocessed. Max cycles is the number
          of reprocessing cycles a device may undergo, so a device is used on at
          most max cycles + 1 patients.
        </p>
        {policiesQuery.error instanceof Error ? (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
            {policiesQuery.error.message}
          </p>
        ) : null}
        {policyError ? (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
            {policyError}
          </p>
        ) : null}
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
                return (
                  <tr
                    key={category}
                    className="border-t border-gray-200 dark:border-gray-700"
                  >
                    <td className="p-2 capitalize">
                      {category.replace(/_/g, " ")}
                    </td>
                    <td className="p-2">
                      <input
                        type="checkbox"
                        aria-label={`${category} reprocessable`}
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
                        aria-label={`${category} max cycles`}
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
                              aria-label={`${category} allows ${type}`}
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
                            {type}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td className="p-2">
                      <input
                        type="checkbox"
                        aria-label={`${category} function check required`}
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
      </section>
    </div>
  );
}
