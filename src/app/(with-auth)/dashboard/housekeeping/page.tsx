"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, RefreshCw, CheckCircle, Flag, UserPlus, Eye, Plus, Edit2 } from "lucide-react";
import {
  getHousekeepingStats,
  getHousekeepingLogs,
  getHousekeepingRequests,
  getHousekeepingZones,
  verifyLog,
  assignHousekeepingRequest,
  verifyHousekeepingRequest,
  createHousekeepingZone,
  updateHousekeepingZone,
  adminCreateHousekeepingRequest,
  type HousekeepingLog,
  type HousekeepingRequest,
  type HousekeepingZone,
  type HousekeepingStats,
} from "@/lib/api/housekeeping";
import { getJSON } from "@/lib/api/core";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function fmtSLA(sla_due_at: string | null | undefined, status: string) {
  if (!sla_due_at) return <span className="text-gray-400 text-xs">—</span>;
  if (["completed", "verified", "closed", "cancelled"].includes(status)) {
    return <span className="text-gray-400 text-xs">Done</span>;
  }
  const diff = new Date(sla_due_at).getTime() - Date.now();
  const mins = Math.round(diff / 60000);
  if (mins < 0) {
    const overMins = Math.abs(mins);
    const label = overMins >= 60 ? `${Math.round(overMins / 60)}h` : `${overMins}m`;
    return <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">OVERDUE {label}</span>;
  }
  const label = mins >= 60 ? `${Math.round(mins / 60)}h left` : `${mins}m left`;
  const color = mins < 30 ? "text-orange-600 bg-orange-50 border-orange-200" : "text-green-600 bg-green-50 border-green-200";
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${color}`}>{label}</span>;
}

const URGENCY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 border-red-300 animate-pulse",
  high: "bg-orange-100 text-orange-700 border-orange-300",
  normal: "bg-gray-100 text-gray-600 border-gray-300",
  low: "bg-green-100 text-green-700 border-green-300",
};

const STATUS_STYLES: Record<string, string> = {
  submitted: "bg-gray-100 text-gray-600 border-gray-300",
  verified: "bg-green-100 text-green-700 border-green-300",
  flagged: "bg-red-100 text-red-700 border-red-300",
  open: "bg-blue-100 text-blue-700 border-blue-300",
  assigned: "bg-yellow-100 text-yellow-700 border-yellow-300",
  in_progress: "bg-purple-100 text-purple-700 border-purple-300",
  completed: "bg-teal-100 text-teal-700 border-teal-300",
  closed: "bg-gray-100 text-gray-600 border-gray-300",
  cancelled: "bg-red-50 text-red-400 border-red-200",
};

function Badge({ value, styleMap }: { value: string; styleMap: Record<string, string> }) {
  const cls = styleMap[value] ?? "bg-gray-100 text-gray-600 border-gray-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border ${cls}`}>
      {value.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Tab = "dashboard" | "logs" | "requests" | "zones" | "performance";

export default function HousekeepingPage() {
  const [tab, setTab] = useState<Tab>("dashboard");

  const TABS: { id: Tab; label: string }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "logs", label: "Logs" },
    { id: "requests", label: "Requests" },
    { id: "zones", label: "Zones" },
    { id: "performance", label: "Staff Performance" },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">🧹 Housekeeping Management</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl mb-6 w-fit flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.id
                ? "bg-white text-gray-800 shadow-sm"
                : "text-gray-600 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "dashboard" && <DashboardTab />}
      {tab === "logs" && <LogsTab />}
      {tab === "requests" && <RequestsTab />}
      {tab === "zones" && <ZonesTab />}
      {tab === "performance" && <PerformanceTab />}
    </div>
  );
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

function DashboardTab() {
  const { data: raw, isLoading, refetch } = useQuery({
    queryKey: ["hk-stats"],
    queryFn: () => getHousekeepingStats(),
    refetchInterval: 60000,
  });

  const stats = raw ? unwrap<HousekeepingStats>(raw) : null;

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>;
  if (!stats) return null;

  const { logs, requests, sla, top_staff, recent_flags } = stats;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button onClick={() => refetch()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Logs Today" value={logs.today} color="teal" />
        <StatCard label="Open Requests" value={requests.open} color="blue" />
        <StatCard label="Urgent Open" value={requests.urgent_open} color="red" />
        <StatCard label="SLA Breached" value={requests.sla_breached} color="orange" />
      </div>

      {/* SLA Stats */}
      <div className="bg-white rounded-xl border p-5">
        <h3 className="font-semibold text-gray-700 mb-4">SLA Performance (30 days)</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-green-600">{sla.completed_within_sla}</div>
            <div className="text-xs text-gray-500">Within SLA</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-red-500">{sla.completed_over_sla}</div>
            <div className="text-xs text-gray-500">Over SLA</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-orange-500">{sla.currently_breached}</div>
            <div className="text-xs text-gray-500">Currently Breached</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-gray-700">
              {sla.avg_completion_minutes ? `${Math.round(parseInt(sla.avg_completion_minutes) / 60)}h` : "—"}
            </div>
            <div className="text-xs text-gray-500">Avg Completion</div>
          </div>
        </div>
      </div>

      {/* Top Staff */}
      {top_staff.length > 0 && (
        <div className="bg-white rounded-xl border p-5">
          <h3 className="font-semibold text-gray-700 mb-4">🏆 Top Performing HK Staff (30 days)</h3>
          <div className="space-y-2">
            {top_staff.map((s, i) => (
              <div key={s.id} className="flex items-center gap-3 py-2 border-b last:border-0">
                <span className="w-6 text-center text-gray-400 text-sm font-bold">{i + 1}</span>
                <span className="flex-1 font-medium text-gray-800">{s.name}</span>
                <span className="text-sm text-teal-700 font-semibold">{s.completions} tasks</span>
                {s.avg_minutes && (
                  <span className="text-xs text-gray-500">
                    avg {Math.round(parseInt(s.avg_minutes))} min
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Flags */}
      {recent_flags.length > 0 && (
        <div className="bg-white rounded-xl border border-red-200 p-5">
          <h3 className="font-semibold text-red-700 mb-4">⚠️ Flagged Logs</h3>
          <div className="space-y-3">
            {recent_flags.map((f) => (
              <div key={f.id} className="flex items-start gap-3 p-3 bg-red-50 rounded-lg">
                <Flag size={16} className="text-red-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-red-700">{f.log_number}</span>
                    <span className="text-xs text-gray-500">{f.staff_name}</span>
                    <span className="text-xs text-gray-400">{fmtDate(f.logged_at)}</span>
                  </div>
                  {f.flag_reason && (
                    <p className="text-xs text-red-600 mt-1">{f.flag_reason}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    teal: "bg-teal-50 border-teal-200 text-teal-700",
    blue: "bg-blue-50 border-blue-200 text-blue-700",
    red: "bg-red-50 border-red-200 text-red-700",
    orange: "bg-orange-50 border-orange-200 text-orange-700",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] ?? colors.teal}`}>
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-xs mt-1 opacity-75">{label}</div>
    </div>
  );
}

// ─── Logs Tab ─────────────────────────────────────────────────────────────────

function LogsTab() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ staff_id: "", zone_id: "", status: "", from: "", to: "" });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [flagModal, setFlagModal] = useState<HousekeepingLog | null>(null);

  const { data: raw, isLoading, refetch } = useQuery({
    queryKey: ["hk-logs", filters],
    queryFn: () => getHousekeepingLogs({ ...filters, limit: 100 }),
  });

  const result = raw ? unwrap<{ logs: HousekeepingLog[]; total: number }>(raw) : null;
  const logs = result?.logs ?? [];

  const verifyMutation = useMutation({
    mutationFn: ({ id, flag_reason }: { id: number; flag_reason?: string }) =>
      verifyLog(id, { flag_reason }),
    onSuccess: () => { toast.success("Log updated"); qc.invalidateQueries({ queryKey: ["hk-logs"] }); setFlagModal(null); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl border p-4 grid grid-cols-2 md:grid-cols-5 gap-3">
        <input placeholder="Staff ID" className="border rounded-lg px-3 py-2 text-sm" value={filters.staff_id} onChange={(e) => setFilters(f => ({ ...f, staff_id: e.target.value }))} />
        <input placeholder="Zone ID" className="border rounded-lg px-3 py-2 text-sm" value={filters.zone_id} onChange={(e) => setFilters(f => ({ ...f, zone_id: e.target.value }))} />
        <select className="border rounded-lg px-3 py-2 text-sm" value={filters.status} onChange={(e) => setFilters(f => ({ ...f, status: e.target.value }))}>
          <option value="">All Status</option>
          <option value="submitted">Submitted</option>
          <option value="verified">Verified</option>
          <option value="flagged">Flagged</option>
        </select>
        <input type="date" className="border rounded-lg px-3 py-2 text-sm" value={filters.from} onChange={(e) => setFilters(f => ({ ...f, from: e.target.value }))} />
        <input type="date" className="border rounded-lg px-3 py-2 text-sm" value={filters.to} onChange={(e) => setFilters(f => ({ ...f, to: e.target.value }))} />
      </div>

      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-500">{result?.total ?? 0} logs</span>
        <button onClick={() => refetch()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"><RefreshCw size={14} /> Refresh</button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No cleaning logs found</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {["Log#", "Staff", "Zone", "Type", "Time", "Status", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <React.Fragment key={log.id}>
                  <tr
                    className="border-b hover:bg-gray-50 cursor-pointer"
                    onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-teal-700">{log.log_number}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{log.staff_name ?? "—"}</div>
                      <div className="text-xs text-gray-400">{log.department}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{log.zone_name ?? log.location_text ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-600 capitalize">{log.cleaning_type.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{fmtDate(log.logged_at)}</td>
                    <td className="px-4 py-3"><Badge value={log.status} styleMap={STATUS_STYLES} /></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                        {log.status === "submitted" && (
                          <>
                            <button
                              onClick={() => verifyMutation.mutate({ id: log.id })}
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
                            {log.notes && <p className="text-gray-600"><span className="font-medium">Notes:</span> {log.notes}</p>}
                            {log.flag_reason && <p className="text-red-600 mt-1"><span className="font-medium">Flag reason:</span> {log.flag_reason}</p>}
                            {log.verified_by_name && <p className="text-gray-500 text-xs mt-1">Verified by {log.verified_by_name} at {fmtDate(log.verified_at)}</p>}
                          </div>
                          {log.photo_url && (
                            <div>
                              <a href={log.photo_url} target="_blank" rel="noreferrer" className="inline-block">
                                <img src={log.photo_url} alt="Cleaning evidence" className="max-h-40 rounded border" />
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

      {/* Flag Modal */}
      {flagModal && (
        <FlagModal
          log={flagModal}
          onClose={() => setFlagModal(null)}
          onSubmit={(reason) => verifyMutation.mutate({ id: flagModal.id, flag_reason: reason })}
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
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">Flag Log {log.log_number}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <textarea
          className="w-full border rounded-lg p-3 text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-red-300"
          placeholder="Reason for flagging..."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
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

// ─── Requests Tab ─────────────────────────────────────────────────────────────

function RequestsTab() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ status: "", urgency: "", assigned_to: "", from: "", to: "" });
  const [assignModal, setAssignModal] = useState<HousekeepingRequest | null>(null);
  const [detailPanel, setDetailPanel] = useState<HousekeepingRequest | null>(null);
  const [newRequestModal, setNewRequestModal] = useState(false);

  const { data: raw, isLoading, refetch } = useQuery({
    queryKey: ["hk-requests", filters],
    queryFn: () => getHousekeepingRequests({ ...filters, limit: 100 }),
  });

  const { data: zonesRaw } = useQuery({ queryKey: ["hk-zones"], queryFn: getHousekeepingZones });
  const zones = zonesRaw ? unwrap<HousekeepingZone[]>(zonesRaw) : [];

  const result = raw ? unwrap<{ requests: HousekeepingRequest[]; total: number }>(raw) : null;
  const requests = result?.requests ?? [];

  const verifyMut = useMutation({
    mutationFn: (id: number) => verifyHousekeepingRequest(id),
    onSuccess: () => { toast.success("Request verified"); qc.invalidateQueries({ queryKey: ["hk-requests"] }); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      {/* Filters + New Request */}
      <div className="flex flex-wrap gap-3 items-start">
        <div className="bg-white rounded-xl border p-4 grid grid-cols-2 md:grid-cols-5 gap-3 flex-1">
          <select className="border rounded-lg px-3 py-2 text-sm" value={filters.status} onChange={(e) => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All Status</option>
            {["open", "assigned", "in_progress", "completed", "verified", "closed", "cancelled"].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ").toUpperCase()}</option>
            ))}
          </select>
          <select className="border rounded-lg px-3 py-2 text-sm" value={filters.urgency} onChange={(e) => setFilters(f => ({ ...f, urgency: e.target.value }))}>
            <option value="">All Urgency</option>
            {["urgent", "high", "normal", "low"].map((u) => (
              <option key={u} value={u}>{u.toUpperCase()}</option>
            ))}
          </select>
          <input placeholder="Assigned to (Staff ID)" className="border rounded-lg px-3 py-2 text-sm" value={filters.assigned_to} onChange={(e) => setFilters(f => ({ ...f, assigned_to: e.target.value }))} />
          <input type="date" className="border rounded-lg px-3 py-2 text-sm" value={filters.from} onChange={(e) => setFilters(f => ({ ...f, from: e.target.value }))} />
          <input type="date" className="border rounded-lg px-3 py-2 text-sm" value={filters.to} onChange={(e) => setFilters(f => ({ ...f, to: e.target.value }))} />
        </div>
        <button
          onClick={() => setNewRequestModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 whitespace-nowrap"
        >
          <Plus size={16} /> New Request
        </button>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-500">{result?.total ?? 0} requests</span>
        <button onClick={() => refetch()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"><RefreshCw size={14} /> Refresh</button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No requests found</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {["Req#", "Location", "Type", "Urgency", "Raised By", "Assigned To", "Status", "SLA", "Actions"].map((h) => (
                  <th key={h} className="px-3 py-3 text-left font-semibold text-gray-600 text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-3 font-mono text-xs font-semibold text-orange-600">{req.request_number}</td>
                  <td className="px-3 py-3 text-gray-700 max-w-[140px] truncate" title={req.zone_name ?? req.location_text}>{req.zone_name ?? req.location_text}</td>
                  <td className="px-3 py-3 text-gray-500 capitalize text-xs">{req.request_type.replace(/_/g, " ")}</td>
                  <td className="px-3 py-3"><Badge value={req.urgency} styleMap={URGENCY_STYLES} /></td>
                  <td className="px-3 py-3">
                    <div className="text-xs">
                      <div className="font-medium">{req.requester_name ?? "—"}</div>
                      <div className="text-gray-400">{req.requester_dept}</div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-gray-600 text-xs">{req.assigned_to_name ?? <span className="text-gray-400">Unassigned</span>}</td>
                  <td className="px-3 py-3"><Badge value={req.status} styleMap={STATUS_STYLES} /></td>
                  <td className="px-3 py-3">{fmtSLA(req.sla_due_at, req.status)}</td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1.5">
                      {(req.status === "open" || req.status === "assigned") && (
                        <button
                          onClick={() => setAssignModal(req)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-medium border border-blue-200"
                        >
                          <UserPlus size={11} /> Assign
                        </button>
                      )}
                      {req.status === "completed" && (
                        <button
                          onClick={() => verifyMut.mutate(req.id)}
                          disabled={verifyMut.isPending}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-green-50 text-green-700 hover:bg-green-100 text-xs font-medium border border-green-200 disabled:opacity-50"
                        >
                          <CheckCircle size={11} /> Verify
                        </button>
                      )}
                      <button
                        onClick={() => setDetailPanel(req)}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-gray-50 text-gray-600 hover:bg-gray-100 text-xs font-medium border border-gray-200"
                      >
                        <Eye size={11} /> Detail
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assignModal && (
        <AssignModal
          req={assignModal}
          onClose={() => setAssignModal(null)}
          onAssigned={() => { qc.invalidateQueries({ queryKey: ["hk-requests"] }); setAssignModal(null); }}
        />
      )}

      {detailPanel && (
        <DetailPanel
          req={detailPanel}
          onClose={() => setDetailPanel(null)}
        />
      )}

      {newRequestModal && (
        <NewRequestModal
          zones={zones}
          onClose={() => setNewRequestModal(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ["hk-requests"] }); setNewRequestModal(false); }}
        />
      )}
    </div>
  );
}

function AssignModal({
  req,
  onClose,
  onAssigned,
}: {
  req: HousekeepingRequest;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [staffId, setStaffId] = useState("");
  const [note, setNote] = useState("");

  const { data: staffRaw } = useQuery({
    queryKey: ["staff-list"],
    queryFn: () => getJSON<unknown>("/api/v1/staff/admin/search?limit=100"),
  });

  // Staff search returns s.* from staff table — user_id is the integer FK to users.id
  // assigned_to in housekeeping_requests is integer FK to users.id
  const staffList: Array<{ user_id: number; name: string }> = (() => {
    if (!staffRaw) return [];
    const d = unwrap<{ staff?: Array<{ user_id: number; name: string }> }>(staffRaw);
    return d?.staff ?? [];
  })();

  const mut = useMutation({
    mutationFn: () => assignHousekeepingRequest(req.id, { assigned_to: parseInt(staffId), note: note || undefined }),
    onSuccess: () => { toast.success("Request assigned"); onAssigned(); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">Assign {req.request_number}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Assign to Staff *</label>
            {staffList.length > 0 ? (
              <select
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">— Select staff member —</option>
                {staffList.map((s) => (
                  <option key={s.user_id} value={s.user_id}>{s.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                placeholder="Enter staff user ID"
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              />
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Note (optional)</label>
            <textarea
              className="w-full border rounded-lg p-3 text-sm h-20 resize-none"
              placeholder="Any instructions..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !staffId}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {mut.isPending ? "Assigning..." : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewRequestModal({
  zones,
  onClose,
  onCreated,
}: {
  zones: HousekeepingZone[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    zone_id: "",
    location_text: "",
    request_type: "cleaning",
    urgency: "normal",
    description: "",
  });

  const mut = useMutation({
    mutationFn: () => adminCreateHousekeepingRequest({
      zone_id: form.zone_id ? parseInt(form.zone_id) : undefined,
      location_text: form.location_text || undefined,
      request_type: form.request_type,
      urgency: form.urgency,
      description: form.description || undefined,
    }),
    onSuccess: () => { toast.success("Request created"); onCreated(); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const valid = form.zone_id || form.location_text.trim();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">New Emergency Request</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Zone</label>
            <select
              className="w-full border rounded-lg px-3 py-2 text-sm"
              value={form.zone_id}
              onChange={(e) => setForm(f => ({ ...f, zone_id: e.target.value }))}
            >
              <option value="">— Select zone (or enter location below) —</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name} ({z.zone_type})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Location text (if no zone)</label>
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. Corridor near OPD"
              value={form.location_text}
              onChange={(e) => setForm(f => ({ ...f, location_text: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Type</label>
              <select
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.request_type}
                onChange={(e) => setForm(f => ({ ...f, request_type: e.target.value }))}
              >
                {["cleaning", "deep_clean", "waste_removal", "sanitization", "maintenance", "other"].map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Urgency</label>
              <select
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.urgency}
                onChange={(e) => setForm(f => ({ ...f, urgency: e.target.value }))}
              >
                {["urgent", "high", "normal", "low"].map((u) => (
                  <option key={u} value={u}>{u.toUpperCase()}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Description</label>
            <textarea
              className="w-full border rounded-lg p-3 text-sm h-20 resize-none"
              placeholder="Describe the issue..."
              value={form.description}
              onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !valid}
            className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {mut.isPending ? "Creating..." : "Create Request"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({
  req,
  onClose,
}: {
  req: HousekeepingRequest;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-end md:items-center justify-center md:justify-end z-50">
      <div className="bg-white w-full md:w-[420px] md:h-full h-[85vh] overflow-y-auto shadow-xl">
        <div className="flex justify-between items-center p-5 border-b sticky top-0 bg-white">
          <div>
            <h3 className="font-bold text-gray-800">{req.request_number}</h3>
            <div className="flex gap-2 mt-1">
              <Badge value={req.urgency} styleMap={URGENCY_STYLES} />
              <Badge value={req.status} styleMap={STATUS_STYLES} />
            </div>
          </div>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>

        <div className="p-5 space-y-4">
          <InfoRow label="Location" value={req.zone_name ?? req.location_text} />
          <InfoRow label="Type" value={req.request_type.replace(/_/g, " ")} />
          <InfoRow label="Raised by" value={`${req.requester_name ?? "—"} (${req.requester_dept ?? ""})`} />
          <InfoRow label="Raised at" value={fmtDate(req.created_at)} />
          <InfoRow label="Assigned to" value={req.assigned_to_name ?? "—"} />
          {req.assigned_at && <InfoRow label="Assigned at" value={fmtDate(req.assigned_at)} />}
          {req.description && <InfoRow label="Description" value={req.description} />}
          {req.sla_due_at && <InfoRow label="SLA Due" value={fmtDate(req.sla_due_at)} />}

          {req.photo_url && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">Problem Photo</div>
              <a href={req.photo_url} target="_blank" rel="noreferrer">
                <img src={req.photo_url} alt="Problem" className="max-h-48 rounded border w-full object-cover" />
              </a>
            </div>
          )}

          {req.completed_at && (
            <div className="pt-2 border-t space-y-2">
              <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Completion</div>
              <InfoRow label="Completed at" value={fmtDate(req.completed_at)} />
              {req.completion_notes && <InfoRow label="Notes" value={req.completion_notes} />}
              {req.completion_photo_url && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">Completion Photo</div>
                  <a href={req.completion_photo_url} target="_blank" rel="noreferrer">
                    <img src={req.completion_photo_url} alt="Completion" className="max-h-48 rounded border w-full object-cover" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-sm text-gray-800 mt-0.5">{value}</div>
    </div>
  );
}

// ─── Zones Tab ────────────────────────────────────────────────────────────────

const ZONE_TYPES = ["general", "ward", "corridor", "icu", "ot", "emergency", "pharmacy", "lab", "outpatient", "cafeteria", "restroom", "storage"];

function ZonesTab() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [addModal, setAddModal] = useState(false);
  const [editZone, setEditZone] = useState<HousekeepingZone | null>(null);

  const { data: raw, isLoading, refetch } = useQuery({
    queryKey: ["hk-zones-all"],
    queryFn: () => getJSON<unknown>("/api/v1/staff/admin/housekeeping/zones"),
  });

  // Get all zones including inactive
  const allZones: HousekeepingZone[] = (() => {
    if (!raw) return [];
    const d = unwrap<HousekeepingZone[] | { zones?: HousekeepingZone[] }>(raw);
    if (Array.isArray(d)) return d;
    return (d as { zones?: HousekeepingZone[] }).zones ?? [];
  })();

  const zones = showAll ? allZones : allZones.filter(z => z.is_active);

  const toggleMut = useMutation({
    mutationFn: (zone: HousekeepingZone) =>
      updateHousekeepingZone(zone.id, { is_active: !zone.is_active }),
    onSuccess: () => { toast.success("Zone updated"); qc.invalidateQueries({ queryKey: ["hk-zones-all"] }); qc.invalidateQueries({ queryKey: ["hk-zones"] }); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{zones.length} zones</span>
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="rounded"
            />
            Show inactive
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"><RefreshCw size={14} /></button>
          <button
            onClick={() => setAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700"
          >
            <Plus size={16} /> Add Zone
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : zones.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No zones found</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {["Name", "Type", "Floor", "Building", "Status", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {zones.map((zone) => (
                <tr key={zone.id} className={`border-b hover:bg-gray-50 ${!zone.is_active ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3 font-medium text-gray-800">{zone.name}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold border bg-blue-50 text-blue-700 border-blue-200 capitalize">
                      {zone.zone_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{zone.floor ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-500">{zone.building ?? "—"}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleMut.mutate(zone)}
                      disabled={toggleMut.isPending}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${zone.is_active ? "bg-teal-500" : "bg-gray-300"}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${zone.is_active ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setEditZone(zone)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-gray-50 text-gray-600 hover:bg-gray-100 text-xs font-medium border border-gray-200"
                    >
                      <Edit2 size={11} /> Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addModal && (
        <ZoneFormModal
          onClose={() => setAddModal(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["hk-zones-all"] }); qc.invalidateQueries({ queryKey: ["hk-zones"] }); setAddModal(false); }}
        />
      )}

      {editZone && (
        <ZoneFormModal
          zone={editZone}
          onClose={() => setEditZone(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["hk-zones-all"] }); qc.invalidateQueries({ queryKey: ["hk-zones"] }); setEditZone(null); }}
        />
      )}
    </div>
  );
}

function ZoneFormModal({
  zone,
  onClose,
  onSaved,
}: {
  zone?: HousekeepingZone;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: zone?.name ?? "",
    zone_type: zone?.zone_type ?? "general",
    floor: zone?.floor ?? "",
    building: zone?.building ?? "",
    is_active: zone?.is_active ?? true,
  });

  const mut = useMutation({
    mutationFn: () =>
      zone
        ? updateHousekeepingZone(zone.id, { ...form, floor: form.floor || undefined, building: form.building || undefined })
        : createHousekeepingZone({ ...form, floor: form.floor || undefined, building: form.building || undefined }),
    onSuccess: () => { toast.success(zone ? "Zone updated" : "Zone created"); onSaved(); },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">{zone ? "Edit Zone" : "Add New Zone"}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Zone Name *</label>
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. ICU East Wing"
              value={form.name}
              onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Zone Type</label>
            <select
              className="w-full border rounded-lg px-3 py-2 text-sm"
              value={form.zone_type}
              onChange={(e) => setForm(f => ({ ...f, zone_type: e.target.value }))}
            >
              {ZONE_TYPES.map((t) => (
                <option key={t} value={t}>{t.toUpperCase()}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Floor</label>
              <input
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Ground, First"
                value={form.floor}
                onChange={(e) => setForm(f => ({ ...f, floor: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Building</label>
              <input
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Main Block"
                value={form.building}
                onChange={(e) => setForm(f => ({ ...f, building: e.target.value }))}
              />
            </div>
          </div>
          {zone && (
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700">Active</label>
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.is_active ? "bg-teal-500" : "bg-gray-300"}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.is_active ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !form.name.trim()}
            className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {mut.isPending ? "Saving..." : zone ? "Update Zone" : "Create Zone"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Staff Performance Tab ────────────────────────────────────────────────────

function PerformanceTab() {
  const { data: raw, isLoading, refetch } = useQuery({
    queryKey: ["hk-stats-perf"],
    queryFn: () => getHousekeepingStats(),
    refetchInterval: 120000,
  });

  const stats = raw ? unwrap<HousekeepingStats>(raw) : null;

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></div>;
  if (!stats) return null;

  const { top_staff, recent_flags, logs, requests } = stats;

  // Build flag reason breakdown from recent_flags
  const flagReasons: Record<string, number> = {};
  const flagByStaff: Record<string, number> = {};
  for (const f of recent_flags) {
    const reason = f.flag_reason ?? "unspecified";
    flagReasons[reason] = (flagReasons[reason] ?? 0) + 1;
    const staff = f.staff_name ?? "Unknown";
    flagByStaff[staff] = (flagByStaff[staff] ?? 0) + 1;
  }

  const sortedFlagStaff = Object.entries(flagByStaff).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-gray-800">Staff Performance Overview (30 days)</h2>
        <button onClick={() => refetch()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Logs" value={logs.total} color="teal" />
        <StatCard label="Verified Logs" value={logs.verified} color="blue" />
        <StatCard label="Flagged Logs" value={logs.flagged} color="red" />
        <StatCard label="Tasks Completed" value={requests.completed} color="orange" />
      </div>

      {/* Top Performers Table */}
      <div className="bg-white rounded-xl border p-5">
        <h3 className="font-semibold text-gray-700 mb-4">🏆 Top Performers</h3>
        {top_staff.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-4">No data available yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {["Rank", "Staff Name", "Tasks Completed", "Avg Completion"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {top_staff.map((s, i) => (
                  <tr key={s.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                        i === 0 ? "bg-yellow-100 text-yellow-700" :
                        i === 1 ? "bg-gray-100 text-gray-600" :
                        i === 2 ? "bg-orange-100 text-orange-600" : "text-gray-400"
                      }`}>{i + 1}</span>
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-800">{s.name}</td>
                    <td className="px-4 py-3 text-teal-700 font-semibold">{s.completions}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {s.avg_minutes ? `${Math.round(parseInt(s.avg_minutes))} min` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Flags Breakdown */}
      {recent_flags.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Staff with most flags */}
          <div className="bg-white rounded-xl border border-red-100 p-5">
            <h3 className="font-semibold text-red-700 mb-4">⚠️ Staff with Flags</h3>
            {sortedFlagStaff.length === 0 ? (
              <p className="text-gray-400 text-sm">No flagged staff</p>
            ) : (
              <div className="space-y-2">
                {sortedFlagStaff.map(([name, count]) => (
                  <div key={name} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <span className="text-sm text-gray-700">{name}</span>
                    <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">
                      {count} flag{count > 1 ? "s" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Flag reason breakdown */}
          <div className="bg-white rounded-xl border border-red-100 p-5">
            <h3 className="font-semibold text-red-700 mb-4">🔍 Flag Reasons</h3>
            {Object.keys(flagReasons).length === 0 ? (
              <p className="text-gray-400 text-sm">No flag reasons</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(flagReasons)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <div key={reason} className="flex items-start gap-2 py-1.5 border-b last:border-0">
                      <span className="flex-1 text-sm text-gray-600 break-words">{reason}</span>
                      <span className="text-xs font-semibold text-orange-600 shrink-0">{count}×</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recent flags detail */}
      {recent_flags.length > 0 && (
        <div className="bg-white rounded-xl border p-5">
          <h3 className="font-semibold text-gray-700 mb-4">Recent Flagged Logs</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {["Log#", "Staff", "Zone", "Reason", "Date"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-semibold text-gray-600 text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent_flags.map((f) => (
                  <tr key={f.id} className="border-t hover:bg-red-50">
                    <td className="px-4 py-2 font-mono text-xs text-red-700">{f.log_number}</td>
                    <td className="px-4 py-2 text-gray-700">{f.staff_name ?? "—"}</td>
                    <td className="px-4 py-2 text-gray-500">{f.zone_name ?? "—"}</td>
                    <td className="px-4 py-2 text-red-600 text-xs max-w-[200px] truncate" title={f.flag_reason ?? ""}>{f.flag_reason ?? "—"}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{fmtDate(f.logged_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
