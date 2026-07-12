"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import type {
  DoseRollupResponse,
  DoseSettingsResponse,
  DoseThresholds,
} from "./types";

function firstOfMonthsAgo(months: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - months, 1)
    .toISOString()
    .slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const THRESHOLD_FIELDS: Array<{ key: keyof DoseThresholds; label: string }> = [
  { key: "fluoro_time_alert_min", label: "Fluoro time alert (min)" },
  { key: "dap_alert_gy_cm2", label: "DAP alert (Gy·cm²)" },
  { key: "air_kerma_alert_mgy", label: "Air kerma alert (mGy)" },
  { key: "contrast_volume_alert_ml", label: "Contrast alert (ml)" },
];

function formatMetric(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString();
}

export default function DoseRollupTab() {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(() => firstOfMonthsAgo(5));
  const [to, setTo] = useState(() => today());
  const [groupBy, setGroupBy] = useState<"month" | "operator">("month");
  const [editingThresholds, setEditingThresholds] = useState(false);
  const [thresholdForm, setThresholdForm] = useState<Record<string, string>>({});

  const settingsQuery = useQuery({
    queryKey: ["cath-dose-settings"],
    queryFn: () => fetchAdminAPI<DoseSettingsResponse>("/quality/cath/dose-settings"),
  });

  const rollupQuery = useQuery({
    queryKey: ["cath-dose-rollup", from, to, groupBy],
    queryFn: () =>
      fetchAdminAPI<DoseRollupResponse>(
        `/quality/cath/dose-rollup?from=${from}&to=${to}&group_by=${groupBy}`,
      ),
    enabled: Boolean(from && to),
  });

  const saveThresholds = useMutation({
    mutationFn: (body: Record<string, number | string | null>) =>
      fetchAdminAPI<{ settings: DoseThresholds }>("/quality/cath/dose-settings", {
        method: "PUT",
        body,
      }),
    onSuccess: () => {
      toast.success("Dose alert thresholds saved");
      setEditingThresholds(false);
      queryClient.invalidateQueries({ queryKey: ["cath-dose-settings"] });
      queryClient.invalidateQueries({ queryKey: ["cath-dose-rollup"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Failed to save thresholds");
    },
  });

  const settings = settingsQuery.data;
  const rollup = rollupQuery.data;
  const thresholdsPending = settings?.thresholds_status === "thresholds_pending";

  const openThresholdEditor = () => {
    const current = settings?.settings ?? null;
    const nextForm: Record<string, string> = {};
    for (const field of THRESHOLD_FIELDS) {
      const value = current?.[field.key];
      nextForm[field.key] = value === null || value === undefined ? "" : String(value);
    }
    setThresholdForm(nextForm);
    setEditingThresholds(true);
  };

  const submitThresholds = () => {
    const body: Record<string, number | null> = {};
    for (const field of THRESHOLD_FIELDS) {
      const raw = (thresholdForm[field.key] ?? "").trim();
      if (!raw) {
        body[field.key as string] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error(`${field.label} must be a positive number or empty`);
        return;
      }
      body[field.key as string] = parsed;
    }
    saveThresholds.mutate(body);
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {thresholdsPending ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            )}
            Owner dose alert thresholds
          </h2>
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
            onClick={openThresholdEditor}
          >
            {thresholdsPending ? "Configure thresholds" : "Edit thresholds"}
          </button>
        </div>
        {settingsQuery.isLoading ? (
          <LoadingSpinner label="Loading thresholds" />
        ) : thresholdsPending && !editingThresholds ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Thresholds pending — dose outlier flags stay off until the hospital
            owner configures alert limits. No default dose limits are assumed.
          </p>
        ) : null}
        {!editingThresholds && !thresholdsPending && settings?.settings ? (
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {THRESHOLD_FIELDS.map((field) => (
              <div key={field.key as string}>
                <dt className="text-gray-500 dark:text-gray-400">{field.label}</dt>
                <dd className="font-semibold">
                  {formatMetric(settings.settings?.[field.key] as number | null)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {editingThresholds ? (
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {THRESHOLD_FIELDS.map((field) => (
                <label key={field.key as string} className="text-xs">
                  <span className="mb-1 block text-gray-600 dark:text-gray-300">
                    {field.label}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={thresholdForm[field.key as string] ?? ""}
                    onChange={(event) =>
                      setThresholdForm((prev) => ({
                        ...prev,
                        [field.key as string]: event.target.value,
                      }))
                    }
                    className="w-full rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
                    placeholder="unset"
                  />
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submitThresholds}
                disabled={saveThresholds.isPending}
                className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saveThresholds.isPending ? "Saving…" : "Save thresholds"}
              </button>
              <button
                type="button"
                onClick={() => setEditingThresholds(false)}
                className="rounded-md border border-gray-300 px-3 py-1 text-xs dark:border-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="mb-1 block text-gray-600 dark:text-gray-300">From</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-gray-600 dark:text-gray-300">To</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
            />
          </label>
          <div className="flex overflow-hidden rounded-md border border-gray-300 text-xs dark:border-gray-600">
            {(["month", "operator"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setGroupBy(mode)}
                className={`px-3 py-1 font-medium capitalize ${
                  groupBy === mode
                    ? "bg-blue-600 text-white"
                    : "bg-white hover:bg-gray-50 dark:bg-gray-800 dark:hover:bg-gray-700"
                }`}
              >
                By {mode}
              </button>
            ))}
          </div>
        </div>

        {rollupQuery.isLoading ? (
          <LoadingSpinner label="Computing rollup" />
        ) : rollupQuery.isError ? (
          <EmptyState
            compact
            title="Couldn't compute the dose rollup"
            description={
              rollupQuery.error instanceof Error ? rollupQuery.error.message : undefined
            }
          />
        ) : !rollup || rollup.rows.length === 0 ? (
          <EmptyState
            compact
            title="No dose records in this period"
            description="Rollups derive from cath contrast/radiation records."
          />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="py-2 pr-3 font-medium capitalize">{rollup.group_by}</th>
                  <th className="py-2 pr-3 font-medium">Cases</th>
                  <th className="py-2 pr-3 font-medium">Records</th>
                  <th className="py-2 pr-3 font-medium">Fluoro (min, total/avg)</th>
                  <th className="py-2 pr-3 font-medium">DAP (Gy·cm², total/avg)</th>
                  <th className="py-2 pr-3 font-medium">Air kerma (mGy, total)</th>
                  <th className="py-2 pr-3 font-medium">Contrast (ml, total/avg)</th>
                  <th className="py-2 pr-3 font-medium">Threshold breaches</th>
                </tr>
              </thead>
              <tbody>
                {rollup.rows.map((row) => (
                  <tr
                    key={row.bucket}
                    className="border-b border-gray-100 last:border-0 dark:border-gray-800"
                  >
                    <td className="py-2 pr-3 font-semibold">{row.bucket}</td>
                    <td className="py-2 pr-3">{row.case_count}</td>
                    <td className="py-2 pr-3">{row.record_count}</td>
                    <td className="py-2 pr-3">
                      {formatMetric(row.total_fluoro_time_min)} / {formatMetric(row.avg_fluoro_time_min)}
                    </td>
                    <td className="py-2 pr-3">
                      {formatMetric(row.total_dap_gy_cm2)} / {formatMetric(row.avg_dap_gy_cm2)}
                    </td>
                    <td className="py-2 pr-3">{formatMetric(row.total_air_kerma_mgy)}</td>
                    <td className="py-2 pr-3">
                      {formatMetric(row.total_contrast_ml)} / {formatMetric(row.avg_contrast_ml)}
                    </td>
                    <td className="py-2 pr-3">
                      {rollup.thresholds_status === "thresholds_pending" ? (
                        <span className="text-amber-600 dark:text-amber-400">pending</span>
                      ) : (
                        <span
                          className={
                            (row.breach_count ?? 0) > 0
                              ? "font-semibold text-red-600 dark:text-red-400"
                              : ""
                          }
                        >
                          {row.breach_count ?? 0}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
