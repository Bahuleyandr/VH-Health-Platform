"use client";

import React, { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, AlertTriangle, RefreshCw } from "lucide-react";
import { getIncidents, getIncidentStats, updateIncident } from "@/lib/api/reports";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "react-hot-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Incident {
  id: number;
  report_number: string;
  incident_type: string;
  severity: "low" | "moderate" | "severe" | "sentinel";
  title: string;
  description: string;
  location?: string;
  incident_date: string;
  status: string;
  priority: string;
  reporter_name?: string;
  reporter_department?: string;
  assigned_to_name?: string;
  patient_involved: boolean;
  patient_name?: string;
  witnesses?: string;
  immediate_action_taken?: string;
  admin_notes?: string;
  resolution?: string;
  is_anonymous: boolean;
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

interface IncidentStats {
  summary: {
    new_count: string;
    active_count: string;
    sentinel_count: string;
    severe_count: string;
    this_week: string;
    this_month: string;
    total: string;
  };
  by_type: Array<{ incident_type: string; count: string }>;
}

interface IncidentsResponse {
  incidents: Incident[];
  total: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

const SEVERITY_STYLES: Record<string, string> = {
  sentinel: "bg-red-950 text-white border-red-950",
  severe: "bg-red-600 text-white border-red-600",
  moderate: "bg-orange-100 text-orange-700 border-orange-300",
  low: "bg-green-100 text-green-700 border-green-300",
};

const STATUS_STYLES: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-700 border-blue-300",
  under_review: "bg-yellow-100 text-yellow-700 border-yellow-300",
  investigating: "bg-purple-100 text-purple-700 border-purple-300",
  resolved: "bg-green-100 text-green-700 border-green-300",
  closed: "bg-gray-100 text-gray-600 border-gray-300",
};

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 border-red-300 animate-pulse",
  high: "bg-orange-100 text-orange-700 border-orange-300",
  normal: "bg-gray-100 text-gray-600 border-gray-300",
};

function Badge({ value, styleMap }: { value: string; styleMap: Record<string, string> }) {
  const cls = styleMap[value] ?? "bg-gray-100 text-gray-600 border-gray-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border ${cls}`}>
      {value.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const INCIDENT_TYPES = [
  "patient_fall", "medication_error", "needle_stick", "equipment_failure",
  "near_miss", "infection", "fire_safety", "patient_aggression", "security_breach", "other",
];

const STATUSES = ["submitted", "under_review", "investigating", "resolved", "closed"];
const SEVERITIES = ["low", "moderate", "severe", "sentinel"];

// ─── Side Panel ──────────────────────────────────────────────────────────────

function IncidentPanel({
  incident,
  onClose,
  onUpdated,
}: {
  incident: Incident;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState(incident.status);
  const [resolution, setResolution] = useState(incident.resolution ?? "");
  const [adminNotes, setAdminNotes] = useState(incident.admin_notes ?? "");
  const [publicUpdate, setPublicUpdate] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateIncident(String(incident.id), {
        ...(status !== incident.status ? { status } : {}),
        ...(resolution !== (incident.resolution ?? "") ? { resolution } : {}),
        ...(adminNotes !== (incident.admin_notes ?? "") ? { admin_notes: adminNotes } : {}),
        ...(publicUpdate.trim() ? { public_update: publicUpdate.trim() } : {}),
        ...(internalNote.trim() ? { internal_note: internalNote.trim() } : {}),
      });
      toast.success("Incident updated");
      setPublicUpdate("");
      setInternalNote("");
      onUpdated();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }, [incident, status, resolution, adminNotes, publicUpdate, internalNote, onUpdated]);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-2xl bg-white shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gray-50">
          <div>
            <p className="text-xs text-gray-500 font-mono">{incident.report_number}</p>
            <h2 className="font-bold text-gray-800 text-lg leading-tight">{incident.title}</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-200">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Badges */}
          <div className="flex flex-wrap gap-2">
            <Badge value={incident.severity} styleMap={SEVERITY_STYLES} />
            <Badge value={incident.priority} styleMap={PRIORITY_STYLES} />
            <Badge value={incident.status} styleMap={STATUS_STYLES} />
            {incident.is_anonymous && (
              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold border bg-gray-100 text-gray-500">
                ANONYMOUS
              </span>
            )}
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-gray-500">Type:</span> <span className="font-medium">{incident.incident_type.replace(/_/g, " ")}</span></div>
            <div><span className="text-gray-500">Date:</span> <span className="font-medium">{fmtDate(incident.incident_date)}</span></div>
            {incident.reporter_name && (
              <div><span className="text-gray-500">Reporter:</span> <span className="font-medium">{incident.reporter_name}</span></div>
            )}
            {incident.location && (
              <div><span className="text-gray-500">Location:</span> <span className="font-medium">{incident.location}</span></div>
            )}
            {incident.patient_involved && (
              <div className="col-span-2">
                <span className="text-gray-500">Patient:</span>{" "}
                <span className="font-medium">{incident.patient_name ?? "Involved (name not provided)"}</span>
              </div>
            )}
          </div>

          {/* Description */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Description</p>
            <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap">{incident.description}</p>
          </div>

          {incident.immediate_action_taken && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Immediate Action Taken</p>
              <p className="text-sm text-gray-700">{incident.immediate_action_taken}</p>
            </div>
          )}

          {/* Updates thread */}
          {incident.updates && incident.updates.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Updates</p>
              <div className="space-y-2">
                {incident.updates.map((u) => (
                  <div key={u.id} className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-blue-700">{u.author_role.toUpperCase()}</span>
                      {u.author_name && <span className="text-gray-500">({u.author_name})</span>}
                      <span className="text-xs text-gray-400 ml-auto">{fmtDate(u.created_at)}</span>
                    </div>
                    <p className="text-gray-700">{u.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Update form */}
          <div className="border-t pt-4 space-y-3">
            <p className="text-sm font-semibold text-gray-700">Update Incident</p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, " ").toUpperCase()}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Public Update (visible to reporter)</label>
              <textarea
                value={publicUpdate}
                onChange={(e) => setPublicUpdate(e.target.value)}
                rows={2}
                placeholder="Update the reporter on progress..."
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1 flex items-center gap-1">
                <span className="text-orange-600">🔒</span> Internal Note (admin only — not visible to reporter)
              </label>
              <textarea
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                rows={2}
                placeholder="Internal notes, observations, escalation reasons..."
                className="w-full border border-orange-200 bg-orange-50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none"
              />
            </div>

            {(status === "resolved" || status === "closed") && (
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Resolution (visible to reporter)</label>
                <textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  rows={2}
                  placeholder="Describe how the incident was resolved..."
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                />
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Admin Notes (private)</label>
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                rows={2}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-2.5 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
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

export default function IncidentsPage() {
  const qc = useQueryClient();
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSeverity, setFilterSeverity] = useState("");
  const [filterType, setFilterType] = useState("");
  const [selected, setSelected] = useState<Incident | null>(null);

  const statsQ = useQuery({
    queryKey: ["incident-stats"],
    queryFn: () => getIncidentStats<IncidentStats>().then(unwrap<IncidentStats>),
    staleTime: 30_000,
  });

  const listQ = useQuery({
    queryKey: ["incidents", filterStatus, filterSeverity, filterType],
    queryFn: () =>
      getIncidents<IncidentsResponse>({
        ...(filterStatus ? { status: filterStatus } : {}),
        ...(filterSeverity ? { severity: filterSeverity } : {}),
        ...(filterType ? { incident_type: filterType } : {}),
        limit: 100,
      }).then(unwrap<IncidentsResponse>),
    staleTime: 15_000,
  });

  const stats = statsQ.data;
  const incidents = listQ.data?.incidents ?? [];
  const sentinelCount = parseInt(stats?.summary?.sentinel_count ?? "0");
  const hasSentinel = sentinelCount > 0;

  const handleUpdated = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["incidents"] });
    qc.invalidateQueries({ queryKey: ["incident-stats"] });
    if (selected) {
      // Re-fetch full detail for the panel
      getIncidents<IncidentsResponse>({ limit: 100 })
        .then(unwrap<IncidentsResponse>)
        .then((d) => {
          const fresh = d.incidents.find((i) => i.id === selected.id);
          if (fresh) setSelected(fresh);
        })
        .catch(() => {});
    }
  }, [qc, selected]);

  return (
    <div className="p-6 space-y-5">
      {/* Sentinel alert banner */}
      {hasSentinel && (
        <div className="flex items-center gap-3 bg-red-950 text-white rounded-xl px-5 py-4 shadow-lg">
          <AlertTriangle size={22} className="flex-shrink-0 text-red-200 animate-pulse" />
          <div>
            <p className="font-bold text-lg">⚠ SENTINEL EVENT ALERT</p>
            <p className="text-red-200 text-sm">
              {sentinelCount} sentinel event{sentinelCount > 1 ? "s" : ""} on record. Immediate review required.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Incident Reports</h1>
          <p className="text-sm text-gray-500">Patient safety & operational incident management</p>
        </div>
        <button
          onClick={() => { qc.invalidateQueries({ queryKey: ["incidents"] }); qc.invalidateQueries({ queryKey: ["incident-stats"] }); }}
          className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Stats cards */}
      {statsQ.isLoading ? (
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "New / Unreviewed", value: stats?.summary?.new_count ?? "0", color: "text-blue-600", bg: "bg-blue-50", icon: "📋" },
            { label: "Active", value: stats?.summary?.active_count ?? "0", color: "text-orange-600", bg: "bg-orange-50", icon: "🔍" },
            { label: "Sentinel / Severe", value: `${stats?.summary?.sentinel_count ?? 0} / ${stats?.summary?.severe_count ?? 0}`, color: "text-red-600", bg: "bg-red-50", icon: "🚨" },
            { label: "This Week", value: stats?.summary?.this_week ?? "0", color: "text-gray-700", bg: "bg-gray-50", icon: "📅" },
          ].map((c) => (
            <div key={c.label} className={`rounded-xl border p-4 ${c.bg} shadow-sm`}>
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
          className="border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toUpperCase()}</option>)}
        </select>
        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Severities</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
        </select>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Types</option>
          {INCIDENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        {(filterStatus || filterSeverity || filterType) && (
          <button
            onClick={() => { setFilterStatus(""); setFilterSeverity(""); setFilterType(""); }}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 border rounded-lg"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      {listQ.isLoading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      ) : (
        <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  {["#", "Title", "Type", "Severity", "Reporter", "Date", "Priority", "Status"].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {incidents.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-gray-400">No incidents found</td>
                  </tr>
                )}
                {incidents.map((inc) => (
                  <tr
                    key={inc.id}
                    onClick={() => setSelected(inc)}
                    className="hover:bg-blue-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-blue-600 font-bold whitespace-nowrap">
                      {inc.report_number}
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <p className="font-medium text-gray-800 truncate">{inc.title}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {inc.incident_type.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3">
                      <Badge value={inc.severity} styleMap={SEVERITY_STYLES} />
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {inc.is_anonymous ? "Anonymous" : (inc.reporter_name ?? "—")}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                      {fmtDate(inc.incident_date)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge value={inc.priority} styleMap={PRIORITY_STYLES} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge value={inc.status} styleMap={STATUS_STYLES} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {incidents.length > 0 && (
            <div className="px-4 py-3 border-t bg-gray-50 text-xs text-gray-500">
              {incidents.length} incident{incidents.length !== 1 ? "s" : ""} shown
            </div>
          )}
        </div>
      )}

      {/* Side panel */}
      {selected && (
        <IncidentPanel
          incident={selected}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  );
}
