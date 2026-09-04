"use client";

// The reprocessable cath-device queue (GET /cssd/devices).
//
// A device lands here when the cath lab taps "sent for reprocessing" on a used
// catheter, wire, balloon or sheath. From there CSSD receives it, records a
// completed cycle, or takes it out of circulation. The controls offered per row
// mirror the backend state machine exactly — a control for a transition
// cathDeviceReuseService refuses could only ever answer 409
// CATH_DEVICE_INVALID_TRANSITION.

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  CSSD_DEVICE_LIST_LIMIT,
  CSSD_DEVICE_STATUSES,
  listCssdDevices,
  type CathDevice,
  type CathDeviceStatus,
} from "@/lib/api/cathDevices";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import {
  DEVICE_ACTION_LABEL,
  DeviceActionDialog,
  type DeviceAction,
} from "./DeviceActions";
import { StatusPill, fmtDate, humanize, inputClass } from "./helpers";

/**
 * Mirror of the transitions cathDeviceReuseService allows out of each status.
 * `in_case` and `discarded` are terminal from this console: a device in a case
 * moves through the cath-lab post-use tap, and a discard is irreversible.
 */
const ACTIONS_BY_STATUS: Record<CathDeviceStatus, DeviceAction[]> = {
  awaiting_reprocessing: ["receive", "reprocessed", "quarantine", "discard"],
  in_cssd: ["reprocessed", "quarantine", "discard"],
  available: ["quarantine", "discard"],
  quarantined: ["release", "discard"],
  in_case: [],
  discarded: [],
};

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
                        {device.exposure_markers.join(", ") || "flagged"}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="p-3 text-xs">{fmtDate(device.updated_at)}</td>
                  <td className="p-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {(ACTIONS_BY_STATUS[device.status] ?? []).map(
                        (action) => (
                          <button
                            key={action}
                            type="button"
                            aria-label={`${DEVICE_ACTION_LABEL[action]} ${device.device_tag}`}
                            onClick={() => setDialog({ device, action })}
                            className={`rounded border px-2 py-1 text-xs font-medium hover:bg-muted ${
                              action === "discard"
                                ? "border-rose-500/40 text-rose-700 dark:text-rose-300"
                                : "border-border"
                            }`}
                          >
                            {DEVICE_ACTION_LABEL[action]}
                          </button>
                        ),
                      )}
                    </div>
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
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
