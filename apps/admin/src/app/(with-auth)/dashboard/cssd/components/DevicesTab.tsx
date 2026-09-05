"use client";

// The reprocessable cath-device queue (GET /cssd/devices).
//
// A device lands here when the cath lab taps "sent for reprocessing" on a used
// catheter, wire, balloon or sheath. From there CSSD receives it, records a
// completed cycle, or takes it out of circulation. The controls offered per row
// mirror the backend state machine exactly — a control for a transition
// cathDeviceReuseService refuses could only ever answer 409
// CATH_DEVICE_INVALID_TRANSITION.
//
// The state machine is not the only gate on "reprocessed": the per-category
// reprocessing policy decides which cycle types may be recorded, and whether
// the category may be reprocessed at all. So this tab reads the policy list
// too (GET /cath-reprocessing/policies, from the same query cache the quality
// console's editor writes) and offers only the cycle types it allows —
// disabling the action outright, with the reason, when it allows none. The
// backend refusals stay the authority: the policy can be rewritten between
// this read and the transition, and a 409 CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED
// or CATH_REPROCESSING_NOT_ALLOWED still surfaces in the dialog.

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  CATH_REPROCESSING_POLICIES_QUERY_KEY,
  CSSD_DEVICE_LIST_LIMIT,
  CSSD_DEVICE_STATUSES,
  allowedCycleTypesForCategory,
  cssdDeviceLabelUrl,
  exposureMarkerLabel,
  listCathReprocessingPolicies,
  listCssdDevices,
  type CathDevice,
  type CathDeviceStatus,
} from "@/lib/api/cathDevices";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  DEVICE_ACTION_LABEL,
  DeviceActionDialog,
  type DeviceAction,
} from "./DeviceActions";
import { StatusPill, fmtDate, humanize, inputClass } from "./helpers";

/**
 * The transitions this console offers out of each status. Every entry is a
 * SUBSET of what cathDeviceReuseService allows — a control the service refuses
 * could only ever answer 409 CATH_DEVICE_INVALID_TRANSITION — and in one place
 * the console deliberately narrows the backend table further:
 *
 *   * `in_case` — the service does allow a discard here, but this console does
 *     not offer one. A device in a case is settled by the cath lab's post-use
 *     tap (used, wasted, or sent for reprocessing), which is the record that
 *     closes out the usage row. Discarding it from CSSD behind the lab's back
 *     would strand that usage and lose the reason the device left the case.
 *   * `discarded` — genuinely terminal; a discard is irreversible.
 */
const ACTIONS_BY_STATUS: Record<CathDeviceStatus, DeviceAction[]> = {
  awaiting_reprocessing: ["receive", "reprocessed", "quarantine", "discard"],
  in_cssd: ["reprocessed", "quarantine", "discard"],
  available: ["quarantine", "discard"],
  quarantined: ["release", "discard"],
  in_case: [],
  discarded: [],
};

/**
 * Where the per-category reprocessing policy is set. There is no deep link to
 * the tab itself — the quality console keeps the active tab in component state
 * — so the link lands on the page and the label names the tab to open.
 */
const POLICY_TAB_HREF = "/dashboard/quality/cath";

export function DevicesTab() {
  const [status, setStatus] = useState<CathDeviceStatus | "">(
    "awaiting_reprocessing",
  );
  const [dialog, setDialog] = useState<{
    device: CathDevice;
    action: DeviceAction;
  } | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["cssd", "devices", { status }],
    queryFn: () =>
      listCssdDevices({
        status: status || undefined,
        limit: CSSD_DEVICE_LIST_LIMIT,
      }),
  });
  const devices = data ?? [];

  // The category policy decides which cycle types CSSD may record — and
  // whether it may record one at all. It is read from the SAME cache entry the
  // quality console's policy editor writes, so a policy saved there is what
  // this picker offers without a second fetch.
  const policiesQuery = useQuery({
    queryKey: CATH_REPROCESSING_POLICIES_QUERY_KEY,
    queryFn: listCathReprocessingPolicies,
    refetchOnWindowFocus: false,
  });

  /**
   * Why this device's Reprocess action cannot be offered, or null when it can.
   *
   * Three refusals, deliberately distinguished: a policy nobody has read yet
   * is UNDECIDABLE, not forbidden, and neither is a policy read that failed —
   * offering the picker in either case would build it from an empty default
   * and hand the operator choices the backend may well accept. Only the third
   * is the policy actually saying no.
   */
  function reprocessBlockedReason(device: CathDevice): string | null {
    if (policiesQuery.isPending) return "Loading the reprocessing policy…";
    if (policiesQuery.isError) {
      return "The reprocessing policy could not be loaded";
    }
    return allowedCycleTypesForCategory(
      policiesQuery.data?.policies,
      device.category,
    ).length === 0
      ? `No reprocessing policy allows ${humanize(device.category)}`
      : null;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Status
          </span>
          <select
            aria-label="Device status"
            className={inputClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as CathDeviceStatus | "")}
          >
            <option value="">All statuses</option>
            {CSSD_DEVICE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>
        </label>
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
      </div>

      {isLoading && <LoadingSpinner label="Loading reprocessable devices" />}

      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error.message}
        </div>
      )}

      {!isLoading && !error && devices.length === 0 && (
        <div className="rounded-lg border border-border">
          <EmptyState
            title="No devices in this state"
            description="Devices arrive here when the cath lab sends a used catheter, wire, balloon or sheath for reprocessing."
          />
        </div>
      )}

      {!isLoading && !error && devices.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-3 text-left">Tag</th>
                <th className="p-3 text-left">Device</th>
                <th className="p-3 text-left">Cycle</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Exposure</th>
                <th className="p-3 text-left">Updated</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id} className="border-t border-border">
                  <td className="p-3 font-mono text-xs">{device.device_tag}</td>
                  <td className="p-3">
                    <div className="font-medium">{device.item_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {humanize(device.category)}
                      {device.manufacturer ? ` · ${device.manufacturer}` : ""}
                    </div>
                  </td>
                  <td className="p-3 text-xs tabular-nums">
                    {device.cycle_count} of {device.max_cycles_snapshot}
                  </td>
                  <td className="p-3">
                    <StatusPill status={device.status} />
                  </td>
                  <td className="p-3 text-xs">
                    {device.exposure_flag ? (
                      <span className="rounded bg-rose-500/15 px-2 py-1 text-rose-700 dark:text-rose-300">
                        {device.exposure_markers
                          .map(exposureMarkerLabel)
                          .join(", ") || "flagged"}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="p-3 text-xs">{fmtDate(device.updated_at)}</td>
                  <td className="p-3 text-right">
                    {(() => {
                      const actions = ACTIONS_BY_STATUS[device.status] ?? [];
                      const blocked = actions.includes("reprocessed")
                        ? reprocessBlockedReason(device)
                        : null;
                      return (
                        <>
                          <div className="flex flex-wrap justify-end gap-1">
                            {device.status !== "discarded" && (
                              <button
                                type="button"
                                aria-label={`Print label ${device.device_tag}`}
                                onClick={() =>
                                  window.open(
                                    cssdDeviceLabelUrl(device.id),
                                    "_blank",
                                    "noopener,noreferrer",
                                  )
                                }
                                className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                              >
                                Print label
                              </button>
                            )}
                            {actions.map((action) => {
                              const refusal =
                                action === "reprocessed" ? blocked : null;
                              return (
                                <button
                                  key={action}
                                  type="button"
                                  aria-label={`${DEVICE_ACTION_LABEL[action]} ${device.device_tag}`}
                                  disabled={refusal !== null}
                                  title={refusal ?? undefined}
                                  onClick={() => setDialog({ device, action })}
                                  className={`rounded border px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
                                    action === "discard"
                                      ? "border-rose-500/40 text-rose-700 dark:text-rose-300"
                                      : "border-border"
                                  }`}
                                >
                                  {DEVICE_ACTION_LABEL[action]}
                                </button>
                              );
                            })}
                          </div>
                          {blocked && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              <span>{blocked}</span>{" "}
                              <Link
                                href={POLICY_TAB_HREF}
                                className="underline underline-offset-2"
                              >
                                Quality › Cath lab quality › Reprocessing policy
                              </Link>
                            </p>
                          )}
                        </>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <DeviceActionDialog
          device={dialog.device}
          action={dialog.action}
          allowedCycleTypes={allowedCycleTypesForCategory(
            policiesQuery.data?.policies,
            dialog.device.category,
          )}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
