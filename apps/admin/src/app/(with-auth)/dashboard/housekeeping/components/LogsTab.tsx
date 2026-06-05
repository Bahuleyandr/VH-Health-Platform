"use client";

import React, { useState } from "react";
import Image from "next/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Flag, RefreshCw, X } from "lucide-react";
import {
  getHousekeepingLogs,
  verifyLog,
  type HousekeepingLog,
} from "@/lib/api/housekeeping";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";
import { Badge, fmtDate, STATUS_STYLES, unwrap } from "./helpers";

export function LogsTab() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState({
    staff_id: "",
    zone_id: "",
    status: "",
    from: "",
    to: "",
  });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [flagModal, setFlagModal] = useState<HousekeepingLog | null>(null);

  const {
    data: raw,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["hk-logs", filters],
    queryFn: () => getHousekeepingLogs({ ...filters, limit: 100 }),
  });

  const result = raw
    ? unwrap<{ logs: HousekeepingLog[]; total: number }>(raw)
    : null;
  const logs = result?.logs ?? [];

  const verifyMutation = useMutation({
    mutationFn: ({ id, flag_reason }: { id: number; flag_reason?: string }) =>
      verifyLog(id, { flag_reason }),
    onSuccess: () => {
      toast.success("Log updated");
      qc.invalidateQueries({ queryKey: ["hk-logs"] });
      setFlagModal(null);
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border p-4 grid grid-cols-2 md:grid-cols-5 gap-3">
        <input
          placeholder="Staff ID"
          className="border rounded-lg px-3 py-2 text-sm"
          value={filters.staff_id}
          onChange={(e) =>
            setFilters((f) => ({ ...f, staff_id: e.target.value }))
          }
        />
        <input
          placeholder="Zone ID"
          className="border rounded-lg px-3 py-2 text-sm"
          value={filters.zone_id}
          onChange={(e) =>
            setFilters((f) => ({ ...f, zone_id: e.target.value }))
          }
        />
        <select
          className="border rounded-lg px-3 py-2 text-sm"
          value={filters.status}
          onChange={(e) =>
            setFilters((f) => ({ ...f, status: e.target.value }))
          }
        >
          <option value="">All Status</option>
          <option value="submitted">Submitted</option>
          <option value="verified">Verified</option>
          <option value="flagged">Flagged</option>
        </select>
        <input
          type="date"
          className="border rounded-lg px-3 py-2 text-sm"
          value={filters.from}
          onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
        />
        <input
          type="date"
          className="border rounded-lg px-3 py-2 text-sm"
          value={filters.to}
          onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
        />
      </div>

      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-500">{result?.total ?? 0} logs</span>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          No cleaning logs found
        </div>
      ) : (
        <div className="bg-card rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {[
                  "Log#",
                  "Staff",
                  "Zone",
                  "Type",
                  "Time",
                  "Status",
                  "Actions",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left font-semibold text-gray-600 text-xs"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <React.Fragment key={log.id}>
                  <tr
                    className="border-b hover:bg-gray-50 cursor-pointer"
                    onClick={() =>
                      setExpanded(expanded === log.id ? null : log.id)
                    }
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-teal-700">
                      {log.log_number}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{log.staff_name ?? "—"}</div>
                      <div className="text-xs text-gray-400">
                        {log.department}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {log.zone_name ?? log.location_text ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-600 capitalize">
                      {log.cleaning_type.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {fmtDate(log.logged_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge value={log.status} styleMap={STATUS_STYLES} />
                    </td>
                    <td className="px-4 py-3">
                      <div
                        className="flex gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {log.status === "submitted" && (
                          <>
                            <button
                              onClick={() =>
                                verifyMutation.mutate({ id: log.id })
                              }
                              className="flex items-center gap-1 px-2 py-1 rounded bg-green-50 text-green-700 hover:bg-green-100 text-xs font-medium border border-green-200"
                            >
                              <CheckCircle size={12} /> Verify
                            </button>
                            <button
                              onClick={() => setFlagModal(log)}
                              className="flex items-center gap-1 px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 text-xs font-medium border border-red-200"
                            >
                              <Flag size={12} /> Flag
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === log.id && (
                    <tr className="bg-gray-50">
                      <td colSpan={7} className="px-6 py-4">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            {log.notes && (
                              <p className="text-gray-600">
                                <span className="font-medium">Notes:</span>{" "}
                                {log.notes}
                              </p>
                            )}
                            {log.flag_reason && (
                              <p className="text-red-600 mt-1">
                                <span className="font-medium">
                                  Flag reason:
                                </span>{" "}
                                {log.flag_reason}
                              </p>
                            )}
                            {log.verified_by_name && (
                              <p className="text-gray-500 text-xs mt-1">
                                Verified by {log.verified_by_name} at{" "}
                                {fmtDate(log.verified_at)}
                              </p>
                            )}
                          </div>
                          {log.photo_url && (
                            <div>
                              <a
                                href={log.photo_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-block relative h-40 w-64"
                              >
                                <Image
                                  src={log.photo_url}
                                  alt="Cleaning evidence"
                                  fill
                                  sizes="256px"
                                  className="rounded border object-cover"
                                  unoptimized
                                />
                              </a>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {flagModal && (
        <FlagModal
          log={flagModal}
          onClose={() => setFlagModal(null)}
          onSubmit={(reason) =>
            verifyMutation.mutate({ id: flagModal.id, flag_reason: reason })
          }
          submitting={verifyMutation.isPending}
        />
      )}
    </div>
  );
}

function FlagModal({
  log,
  onClose,
  onSubmit,
  submitting,
}: {
  log: HousekeepingLog;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">
            Flag Log {log.log_number}
          </h3>
          <button onClick={onClose}>
            <X size={18} className="text-gray-400" />
          </button>
        </div>
        <textarea
          className="w-full border rounded-lg p-3 text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-red-300"
          placeholder="Reason for flagging..."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(reason)}
            disabled={submitting || !reason.trim()}
            className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {submitting ? "Flagging..." : "Flag Log"}
          </button>
        </div>
      </div>
    </div>
  );
}
