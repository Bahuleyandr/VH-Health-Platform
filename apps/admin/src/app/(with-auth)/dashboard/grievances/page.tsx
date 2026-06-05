"use client";

import React, { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Lock, RefreshCw } from "lucide-react";
import {
  getGrievances,
  getGrievanceStats,
  updateGrievance,
} from "@/lib/api/reports";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Grievance {
  id: number;
  grievance_number: string;
  grievance_type: string;
  subject: string;
  description: string;
  against_whom?: string;
  department?: string;
  incident_date?: string;
  is_anonymous: boolean;
  status: string;
  priority: string;
  reporter_name?: string;
  reporter_department?: string;
  assigned_to_name?: string;
  hr_notes?: string;
  resolution?: string;
  resolved_at?: string;
  created_at: string;
  updates?: UpdateItem[];
}

interface UpdateItem {
  id: number;
  author_role: string;
  author_name?: string;
  message: string;
  is_internal: boolean;
  created_at: string;
}

interface GrievanceStats {
  summary: {
    new_count: string;
    active_count: string;
    resolved_count: string;
    anonymous_count: string;
    this_month: string;
    total: string;
  };
  by_type: Array<{ grievance_type: string; count: string }>;
}

interface GrievancesResponse {
  grievances: Grievance[];
  total: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

const STATUS_STYLES: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-700 border-blue-300",
  acknowledged: "bg-cyan-100 text-cyan-700 border-cyan-300",
  under_review: "bg-yellow-100 text-yellow-700 border-yellow-300",
  mediation: "bg-purple-100 text-purple-700 border-purple-300",
  resolved: "bg-green-100 text-green-700 border-green-300",
  closed: "bg-gray-100 text-gray-600 border-gray-300",
  escalated: "bg-red-100 text-red-700 border-red-300",
};

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 border-red-300 animate-pulse",
  high: "bg-orange-100 text-orange-700 border-orange-300",
  normal: "bg-gray-100 text-gray-600 border-gray-300",
};

function Badge({
  value,
  styleMap,
}: {
  value: string;
  styleMap: Record<string, string>;
}) {
  const cls = styleMap[value] ?? "bg-gray-100 text-gray-600 border-gray-300";
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border ${cls}`}
    >
      {value.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const GRIEVANCE_TYPES = [
  "harassment",
  "discrimination",
  "unfair_treatment",
  "unsafe_conditions",
  "workload",
  "pay_dispute",
  "schedule_conflict",
  "policy_violation",
  "other",
];

const STATUSES = [
  "submitted",
  "acknowledged",
  "under_review",
  "mediation",
  "resolved",
  "closed",
  "escalated",
];

// ─── Side Panel ──────────────────────────────────────────────────────────────

function GrievancePanel({
  grievance,
  onClose,
  onUpdated,
}: {
  grievance: Grievance;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState(grievance.status);
  const [resolution, setResolution] = useState(grievance.resolution ?? "");
  const [hrNotes, setHrNotes] = useState(grievance.hr_notes ?? "");
  const [publicUpdate, setPublicUpdate] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateGrievance(String(grievance.id), {
        ...(status !== grievance.status ? { status } : {}),
        ...(resolution !== (grievance.resolution ?? "") ? { resolution } : {}),
        ...(hrNotes !== (grievance.hr_notes ?? "")
          ? { hr_notes: hrNotes }
          : {}),
        ...(publicUpdate.trim() ? { public_update: publicUpdate.trim() } : {}),
        ...(internalNote.trim() ? { internal_note: internalNote.trim() } : {}),
      });
      toast.success("Grievance updated");
      setPublicUpdate("");
      setInternalNote("");
      onUpdated();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }, [
    grievance,
    status,
    resolution,
    hrNotes,
    publicUpdate,
    internalNote,
    onUpdated,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-2xl bg-card shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-purple-50">
          <div>
            <p className="text-xs text-purple-400 font-mono">
              {grievance.grievance_number}
            </p>
            <h2 className="font-bold text-gray-800 text-lg leading-tight">
              {grievance.subject}
            </h2>
            <p className="text-xs text-purple-600 mt-0.5">
              {grievance.grievance_type.replace(/_/g, " ")}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-purple-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Badges */}
          <div className="flex flex-wrap gap-2">
            <Badge value={grievance.status} styleMap={STATUS_STYLES} />
            <Badge value={grievance.priority} styleMap={PRIORITY_STYLES} />
            {grievance.is_anonymous && (
              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold border bg-gray-100 text-gray-500 flex items-center gap-1">
                <Lock size={10} /> ANONYMOUS
              </span>
            )}
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            {!grievance.is_anonymous && grievance.reporter_name && (
              <div>
                <span className="text-gray-500">Reporter:</span>{" "}
                <span className="font-medium">{grievance.reporter_name}</span>
              </div>
            )}
            {!grievance.is_anonymous && grievance.reporter_department && (
              <div>
                <span className="text-gray-500">Department:</span>{" "}
                <span className="font-medium">
                  {grievance.reporter_department}
                </span>
              </div>
            )}
            {grievance.against_whom && (
              <div>
                <span className="text-gray-500">Against:</span>{" "}
                <span className="font-medium">{grievance.against_whom}</span>
              </div>
            )}
            {grievance.department && (
              <div>
                <span className="text-gray-500">Dept:</span>{" "}
                <span className="font-medium">{grievance.department}</span>
              </div>
            )}
            {grievance.incident_date && (
              <div>
                <span className="text-gray-500">Incident Date:</span>{" "}
                <span className="font-medium">
                  {fmtDate(grievance.incident_date)}
                </span>
              </div>
            )}
            <div>
              <span className="text-gray-500">Submitted:</span>{" "}
              <span className="font-medium">
                {fmtDate(grievance.created_at)}
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1">
              Description
            </p>
            <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap">
              {grievance.description}
            </p>
          </div>

          {/* Updates thread */}
          {grievance.updates && grievance.updates.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
                Updates Thread
              </p>
              <div className="space-y-2">
                {grievance.updates.map((u) => (
                  <div
                    key={u.id}
                    className={`rounded-lg p-3 text-sm border ${
                      u.is_internal
                        ? "bg-orange-50 border-orange-200"
                        : "bg-blue-50 border-blue-100"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {u.is_internal && (
                        <Lock size={10} className="text-orange-500" />
                      )}
                      <span
                        className={`font-semibold ${u.is_internal ? "text-orange-700" : "text-blue-700"}`}
                      >
                        {u.author_role.toUpperCase()}
                        {u.is_internal && " (Internal)"}
                      </span>
                      {u.author_name && (
                        <span className="text-gray-500">({u.author_name})</span>
                      )}
                      <span className="text-xs text-gray-400 ml-auto">
                        {fmtDate(u.created_at)}
                      </span>
                    </div>
                    <p className="text-gray-700">{u.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Update form */}
          <div className="border-t pt-4 space-y-3">
            <p className="text-sm font-semibold text-gray-700">
              Update Grievance
            </p>

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, " ").toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                Public Response (visible to reporter)
              </label>
              <textarea
                value={publicUpdate}
                onChange={(e) => setPublicUpdate(e.target.value)}
                rows={2}
                placeholder="Update to share with the reporter..."
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-orange-700 flex items-center gap-1.5 block mb-1 font-semibold">
                <Lock size={12} />
                Internal HR Note — NOT visible to reporter
              </label>
              <textarea
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                rows={3}
                placeholder="Confidential HR observations, investigation notes, escalation context..."
                className="w-full border-2 border-orange-200 bg-orange-50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none"
              />
              <p className="text-xs text-orange-600 mt-1 flex items-center gap-1">
                <Lock size={10} /> This note is strictly internal — never shown
                to the reporter.
              </p>
            </div>

            {(status === "resolved" || status === "closed") && (
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">
                  Resolution (visible to reporter when resolved/closed)
                </label>
                <textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  rows={3}
                  placeholder="Describe how this grievance was resolved..."
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                />
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                HR Notes (ongoing notes, internal reference)
              </label>
              <textarea
                value={hrNotes}
                onChange={(e) => setHrNotes(e.target.value)}
                rows={2}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              />
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-2.5 bg-purple-600 text-white font-semibold rounded-lg hover:bg-purple-700 disabled:opacity-60 transition-colors"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function GrievancesPage() {
  const qc = useQueryClient();
  const [filterStatus, setFilterStatus] = useState("");
  const [filterType, setFilterType] = useState("");
  const [selected, setSelected] = useState<Grievance | null>(null);

  const statsQ = useQuery({
    queryKey: ["grievance-stats"],
    queryFn: () =>
      getGrievanceStats<GrievanceStats>().then(unwrap<GrievanceStats>),
    staleTime: 30_000,
  });

  const listQ = useQuery({
    queryKey: ["grievances", filterStatus, filterType],
    queryFn: () =>
      getGrievances<GrievancesResponse>({
        ...(filterStatus ? { status: filterStatus } : {}),
        ...(filterType ? { grievance_type: filterType } : {}),
        limit: 100,
      }).then(unwrap<GrievancesResponse>),
    staleTime: 15_000,
  });

  const stats = statsQ.data;
  const grievances = listQ.data?.grievances ?? [];

  const handleUpdated = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["grievances"] });
    qc.invalidateQueries({ queryKey: ["grievance-stats"] });
  }, [qc]);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Staff Grievances</h1>
          <p className="text-sm text-gray-500">
            HR-only — confidential staff grievance management
          </p>
        </div>
        <button
          onClick={() => {
            qc.invalidateQueries({ queryKey: ["grievances"] });
            qc.invalidateQueries({ queryKey: ["grievance-stats"] });
          }}
          className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Confidentiality notice */}
      <div className="flex items-center gap-3 bg-purple-50 border border-purple-200 rounded-xl px-5 py-3">
        <Lock size={18} className="text-purple-600 flex-shrink-0" />
        <p className="text-sm text-purple-700">
          <strong>HR Confidential.</strong> This data is visible only to HR and
          senior management. Anonymous submissions must remain anonymous — no
          identity disclosure under any circumstances.
        </p>
      </div>

      {/* Stats cards */}
      {statsQ.isLoading ? (
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              label: "New / Pending",
              value: stats?.summary?.new_count ?? "0",
              color: "text-blue-600",
              bg: "bg-blue-50",
              icon: "📬",
            },
            {
              label: "Under Review",
              value: stats?.summary?.active_count ?? "0",
              color: "text-purple-600",
              bg: "bg-purple-50",
              icon: "🔍",
            },
            {
              label: "Resolved",
              value: stats?.summary?.resolved_count ?? "0",
              color: "text-green-600",
              bg: "bg-green-50",
              icon: "✅",
            },
            {
              label: "Anonymous",
              value: stats?.summary?.anonymous_count ?? "0",
              color: "text-gray-600",
              bg: "bg-gray-50",
              icon: "🔒",
            },
          ].map((c) => (
            <div
              key={c.label}
              className={`rounded-xl border p-4 ${c.bg} shadow-sm`}
            >
              <div className="text-2xl mb-1">{c.icon}</div>
              <p className={`text-2xl font-bold ${c.color}`}>{c.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
        >
          <option value="">All Statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ").toUpperCase()}
            </option>
          ))}
        </select>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
        >
          <option value="">All Types</option>
          {GRIEVANCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {(filterStatus || filterType) && (
          <button
            onClick={() => {
              setFilterStatus("");
              setFilterType("");
            }}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 border rounded-lg"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      {listQ.isLoading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="bg-card border rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-purple-50 border-b">
                <tr>
                  {[
                    "#",
                    "Subject",
                    "Type",
                    "Reporter",
                    "Date",
                    "Priority",
                    "Status",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {grievances.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-12 text-center text-gray-400"
                    >
                      No grievances found
                    </td>
                  </tr>
                )}
                {grievances.map((grv) => (
                  <tr
                    key={grv.id}
                    onClick={() => setSelected(grv)}
                    className="hover:bg-purple-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-purple-600 font-bold whitespace-nowrap">
                      {grv.grievance_number}
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <p className="font-medium text-gray-800 truncate">
                        {grv.subject}
                      </p>
                      {grv.against_whom && (
                        <p className="text-xs text-gray-400">
                          vs {grv.against_whom}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {grv.grievance_type.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {grv.is_anonymous ? (
                        <span className="flex items-center gap-1 text-gray-400">
                          <Lock size={11} /> Anonymous
                        </span>
                      ) : (
                        (grv.reporter_name ?? "—")
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                      {fmtDate(grv.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge value={grv.priority} styleMap={PRIORITY_STYLES} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge value={grv.status} styleMap={STATUS_STYLES} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {grievances.length > 0 && (
            <div className="px-4 py-3 border-t bg-gray-50 text-xs text-gray-500">
              {grievances.length} grievance{grievances.length !== 1 ? "s" : ""}{" "}
              shown
            </div>
          )}
        </div>
      )}

      {/* Side panel */}
      {selected && (
        <GrievancePanel
          grievance={selected}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  );
}
