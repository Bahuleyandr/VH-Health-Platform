// src/app/(with-auth)/dashboard/quality/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";

type QualityIncident = {
  id: number;
  description: string;
  severity: string;
  status: string;
  reporter_uid?: string;
  resolution?: string;
  reported_at: string;
  updated_at?: string;
};

type QualityDashboard = {
  total_incidents: number;
  open_incidents: number;
  resolved_incidents: number;
  by_severity?:
    | Record<string, number>
    | Array<{ severity: string; count: number }>;
  infection_cases_this_month?: number;
  active_outbreaks?: number;
};

type InfectionCase = {
  id: number;
  description: string;
  pathogen?: string;
  ward?: string;
  status: string;
  reported_at: string;
};

const SEVERITY_COLORS: Record<string, string> = {
  LOW: "bg-green-100 text-green-800",
  MEDIUM: "bg-yellow-100 text-yellow-800",
  HIGH: "bg-orange-100 text-orange-800",
  CRITICAL: "bg-red-100 text-red-800",
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-yellow-100 text-yellow-800",
  IN_REVIEW: "bg-blue-100 text-blue-800",
  RESOLVED: "bg-green-100 text-green-800",
  CLOSED: "bg-gray-100 text-gray-600",
};

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${SEVERITY_COLORS[severity?.toUpperCase()] ?? "bg-gray-100 text-gray-600"}`}
    >
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status?.toUpperCase()] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function severityRows(
  bySeverity: QualityDashboard["by_severity"],
): Array<[string, number]> {
  if (!bySeverity) return [];
  if (Array.isArray(bySeverity)) {
    return bySeverity
      .filter((row) => row?.severity)
      .map((row) => [row.severity, Number(row.count) || 0]);
  }
  return Object.entries(bySeverity).map(([severity, count]) => [
    severity,
    Number(count) || 0,
  ]);
}

function StatCard({
  label,
  value,
  color = "text-foreground",
  bg = "bg-card",
}: {
  label: string;
  value: string | number;
  color?: string;
  bg?: string;
}) {
  return (
    <div className={`${bg} border border-border rounded-lg p-4`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function DashboardTab() {
  const [stats, setStats] = useState<QualityDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: QualityDashboard }>(
        "/quality/dashboard",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setStats(data as QualityDashboard);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  const severityBreakdown = severityRows(stats?.by_severity);

  return (
    <div className="space-y-4">
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}
      {stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Total Incidents" value={stats.total_incidents} />
            <StatCard
              label="Open"
              value={stats.open_incidents}
              color="text-orange-600"
              bg="bg-orange-50"
            />
            <StatCard
              label="Resolved"
              value={stats.resolved_incidents}
              color="text-green-700"
              bg="bg-green-50"
            />
            {stats.active_outbreaks !== undefined && (
              <StatCard
                label="Active Outbreaks"
                value={stats.active_outbreaks}
                color={
                  stats.active_outbreaks > 0 ? "text-red-600" : "text-green-700"
                }
                bg={stats.active_outbreaks > 0 ? "bg-red-50" : "bg-green-50"}
              />
            )}
          </div>
          {severityBreakdown.length > 0 && (
            <div className="border border-border rounded-lg p-4">
              <p className="text-sm font-semibold mb-3">
                Incidents by Severity
              </p>
              <div className="flex gap-3 flex-wrap">
                {severityBreakdown.map(([sev, count], index) => (
                  <div
                    key={`${sev}-${index}`}
                    className={`px-4 py-2 rounded-lg text-center ${SEVERITY_COLORS[sev?.toUpperCase()] ?? "bg-gray-100"}`}
                  >
                    <p className="text-lg font-bold">{count}</p>
                    <p className="text-xs font-medium">{sev}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IncidentsTab() {
  const [incidents, setIncidents] = useState<QualityIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [form, setForm] = useState({ description: "", severity: "MEDIUM" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{
    id: number;
    status: string;
    resolution: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: QualityIncident[] }>(
        "/quality/incidents",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setIncidents(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load incidents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const report = async () => {
    if (!form.description) {
      alert("Description is required");
      return;
    }
    setSaving(true);
    try {
      await postJSON("/api/v1/quality/incidents", form);
      setReporting(false);
      setForm({ description: "", severity: "MEDIUM" });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to report incident");
    } finally {
      setSaving(false);
    }
  };

  const update = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await putJSON(`/api/v1/quality/incidents/${editing.id}`, {
        status: editing.status,
        resolution: editing.resolution,
      });
      setEditing(null);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Quality Incidents</h2>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="text-sm text-primary hover:underline"
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => setReporting(true)}
            className="px-3 py-1 bg-primary text-white text-sm rounded-lg"
          >
            + Report
          </button>
        </div>
      </div>
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}
      {!loading && incidents.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No incidents
        </div>
      )}
      {incidents.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">ID</th>
                <th className="py-2 px-3">Description</th>
                <th className="py-2 px-3">Severity</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Date</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr
                  key={i.id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="py-2 px-3 font-mono text-xs">{i.id}</td>
                  <td className="py-2 px-3 max-w-xs truncate">
                    {i.description}
                  </td>
                  <td className="py-2 px-3">
                    <SeverityBadge severity={i.severity} />
                  </td>
                  <td className="py-2 px-3">
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="py-2 px-3">{fmtDate(i.reported_at)}</td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() =>
                        setEditing({
                          id: i.id,
                          status: i.status,
                          resolution: i.resolution ?? "",
                        })
                      }
                      className="text-xs text-primary hover:underline"
                    >
                      Update
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reporting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between">
              <h3 className="font-bold">Report Incident</h3>
              <button
                onClick={() => setReporting(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={3}
              placeholder="Description *"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
            <select
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={() => setReporting(false)}
                className="flex-1 py-2 border rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={report}
                disabled={saving}
                className="flex-1 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50"
              >
                {saving ? "Reporting..." : "Report"}
              </button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between">
              <h3 className="font-bold">Update Incident #{editing.id}</h3>
              <button
                onClick={() => setEditing(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <select
              value={editing.status}
              onChange={(e) =>
                setEditing({ ...editing, status: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {["OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <textarea
              rows={2}
              placeholder="Resolution notes"
              value={editing.resolution}
              onChange={(e) =>
                setEditing({ ...editing, resolution: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setEditing(null)}
                className="flex-1 py-2 border rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={update}
                disabled={saving}
                className="flex-1 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfectionControlTab() {
  const [cases, setCases] = useState<InfectionCase[]>([]);
  const [outbreaks, setOutbreaks] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [form, setForm] = useState({ description: "", pathogen: "", ward: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [casesR, outbreaksR] = await Promise.all([
        fetchAdminAPI<unknown>("/quality/infection-control/surveillance"),
        fetchAdminAPI<unknown>("/quality/infection-control/outbreaks"),
      ]);
      const casesData = ((casesR as Record<string, unknown>).data ??
        casesR) as unknown;
      const outbreaksData = ((outbreaksR as Record<string, unknown>).data ??
        outbreaksR) as unknown;
      setCases(Array.isArray(casesData) ? (casesData as InfectionCase[]) : []);
      setOutbreaks(
        Array.isArray(outbreaksData) ? (outbreaksData as unknown[]) : [],
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load infection data",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reportCase = async () => {
    if (!form.description) {
      alert("Description is required");
      return;
    }
    setSaving(true);
    try {
      await postJSON("/api/v1/quality/infection-control/cases", form);
      setReporting(false);
      setForm({ description: "", pathogen: "", ward: "" });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to report case");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Infection Control</h2>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="text-sm text-primary hover:underline"
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => setReporting(true)}
            className="px-3 py-1 bg-primary text-white text-sm rounded-lg"
          >
            + Report Case
          </button>
        </div>
      </div>
      {outbreaks.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm font-medium">
          ⚠️ {outbreaks.length} active outbreak{outbreaks.length > 1 ? "s" : ""}{" "}
          — immediate attention required
        </div>
      )}
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}
      {!loading && cases.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No infection cases on record
        </div>
      )}
      {cases.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">ID</th>
                <th className="py-2 px-3">Description</th>
                <th className="py-2 px-3">Pathogen</th>
                <th className="py-2 px-3">Ward</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Reported</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="py-2 px-3 font-mono text-xs">{c.id}</td>
                  <td className="py-2 px-3 max-w-xs truncate">
                    {c.description}
                  </td>
                  <td className="py-2 px-3">{c.pathogen ?? "—"}</td>
                  <td className="py-2 px-3">{c.ward ?? "—"}</td>
                  <td className="py-2 px-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="py-2 px-3">{fmtDate(c.reported_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reporting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between">
              <h3 className="font-bold">Report Infection Case</h3>
              <button
                onClick={() => setReporting(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={3}
              placeholder="Description *"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
            <input
              placeholder="Pathogen (optional)"
              value={form.pathogen}
              onChange={(e) => setForm({ ...form, pathogen: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Ward (optional)"
              value={form.ward}
              onChange={(e) => setForm({ ...form, ward: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setReporting(false)}
                className="flex-1 py-2 border rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={reportCase}
                disabled={saving}
                className="flex-1 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50"
              >
                {saving ? "Reporting..." : "Report"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QualityContent() {
  const [tab, setTab] = useState<"dashboard" | "incidents" | "infection">(
    "dashboard",
  );
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Quality & Safety</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[
          { key: "dashboard" as const, label: "📊 Dashboard" },
          { key: "incidents" as const, label: "⚠️ Incidents" },
          { key: "infection" as const, label: "🦠 Infection Control" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "dashboard" && <DashboardTab />}
      {tab === "incidents" && <IncidentsTab />}
      {tab === "infection" && <InfectionControlTab />}
    </div>
  );
}

export default function QualityPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading quality...</div>}>
      <QualityContent />
    </Suspense>
  );
}
