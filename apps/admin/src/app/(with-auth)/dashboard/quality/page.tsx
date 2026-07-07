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

type IsolationBoardRow = {
  source?: string;
  source_kind?: string;
  infection_case_id?: number | string | null;
  isolation_order_id?: number | string | null;
  patient_uid: string;
  patient_name?: string;
  organism?: string | null;
  infection_site?: string | null;
  isolation_type?: string | null;
  ward?: string | null;
  bed_number?: string | null;
  case_status?: string | null;
  order_status?: string | null;
  checklist_status?: {
    total?: number;
    complete?: number;
    pending?: number;
  } | null;
};

type OutbreakEpisode = {
  id: number | string;
  episode_code: string;
  organism: string;
  ward?: string | null;
  status: string;
  case_count?: number;
  suspected_at: string;
};

type HaiRate = {
  hai_type: string;
  device_type?: string | null;
  numerator: number;
  device_days: number;
  rate_per_1000_device_days: number | null;
};

type HandHygieneAudit = {
  id: number;
  audit_date: string;
  ward?: string | null;
  total_moments: number;
  compliant_moments: number;
  compliance_pct: number;
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
  const [isolationRows, setIsolationRows] = useState<IsolationBoardRow[]>([]);
  const [outbreaks, setOutbreaks] = useState<OutbreakEpisode[]>([]);
  const [haiRates, setHaiRates] = useState<HaiRate[]>([]);
  const [handHygiene, setHandHygiene] = useState<HandHygieneAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [form, setForm] = useState({
    patient_uid: "",
    admission_id: "",
    infection_case_id: "",
    precaution_type: "contact",
    reason: "",
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const to = new Date().toISOString().slice(0, 10);
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30);
      const from = fromDate.toISOString().slice(0, 10);
      const [boardR, outbreaksR, haiR, handR] = await Promise.all([
        fetchAdminAPI<unknown>("/infection-control/isolation-board"),
        fetchAdminAPI<unknown>("/infection-control/outbreaks?status=all"),
        fetchAdminAPI<unknown>(`/infection-control/hai-rates?from=${from}&to=${to}`),
        fetchAdminAPI<unknown>(`/infection-control/hand-hygiene-audits?from=${from}&to=${to}`),
      ]);
      const boardData = ((boardR as Record<string, unknown>).data ??
        boardR) as Record<string, unknown>;
      const outbreaksData = ((outbreaksR as Record<string, unknown>).data ??
        outbreaksR) as Record<string, unknown>;
      const haiData = ((haiR as Record<string, unknown>).data ??
        haiR) as Record<string, unknown>;
      const handData = ((handR as Record<string, unknown>).data ??
        handR) as Record<string, unknown>;
      setIsolationRows(
        Array.isArray(boardData.cases)
          ? (boardData.cases as IsolationBoardRow[])
          : [],
      );
      setOutbreaks(
        Array.isArray(outbreaksData.outbreaks)
          ? (outbreaksData.outbreaks as OutbreakEpisode[])
          : [],
      );
      setHaiRates(
        Array.isArray(haiData.rates) ? (haiData.rates as HaiRate[]) : [],
      );
      setHandHygiene(
        Array.isArray(handData.audits)
          ? (handData.audits as HandHygieneAudit[])
          : [],
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

  const createOrder = async () => {
    if (!form.patient_uid) {
      alert("Patient UID is required");
      return;
    }
    setSaving(true);
    try {
      await postJSON("/api/v1/infection-control/isolation-orders", {
        patient_uid: form.patient_uid,
        admission_id: form.admission_id ? Number(form.admission_id) : undefined,
        infection_case_id: form.infection_case_id
          ? Number(form.infection_case_id)
          : undefined,
        precaution_type: form.precaution_type,
        reason: form.reason || undefined,
      });
      setOrdering(false);
      setForm({
        patient_uid: "",
        admission_id: "",
        infection_case_id: "",
        precaution_type: "contact",
        reason: "",
      });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create order");
    } finally {
      setSaving(false);
    }
  };

  const requestTerminalClean = async (id: number | string) => {
    setSaving(true);
    try {
      await postJSON(`/api/v1/infection-control/isolation-orders/${id}/terminal-clean`, {});
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to request terminal clean");
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
            onClick={() => setOrdering(true)}
            className="px-3 py-1 bg-primary text-white text-sm rounded-lg"
          >
            + Isolation Order
          </button>
        </div>
      </div>
      {outbreaks.some((o) => o.status !== "closed") && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm font-medium">
          {outbreaks.filter((o) => o.status !== "closed").length} active outbreak
          {outbreaks.filter((o) => o.status !== "closed").length > 1 ? "s" : ""} require review
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
      {!loading && !error && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Isolation Flags" value={isolationRows.length} />
          <StatCard
            label="Open Outbreaks"
            value={outbreaks.filter((o) => o.status !== "closed").length}
            color={
              outbreaks.some((o) => o.status !== "closed")
                ? "text-red-600"
                : "text-green-700"
            }
            bg={
              outbreaks.some((o) => o.status !== "closed")
                ? "bg-red-50"
                : "bg-green-50"
            }
          />
          <StatCard
            label="HAI Numerator"
            value={haiRates.reduce((sum, row) => sum + Number(row.numerator), 0)}
          />
          <StatCard
            label="Hand Hygiene"
            value={
              handHygiene.length
                ? `${Math.round(
                    handHygiene.reduce(
                      (sum, row) => sum + Number(row.compliance_pct || 0),
                      0,
                    ) / handHygiene.length,
                  )}%`
                : "—"
            }
          />
        </div>
      )}
      {isolationRows.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Patient</th>
                <th className="py-2 px-3">Precaution</th>
                <th className="py-2 px-3">Ward</th>
                <th className="py-2 px-3">Source</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {isolationRows.map((row, index) => (
                <tr
                  key={`${row.source ?? row.source_kind}-${row.isolation_order_id ?? row.infection_case_id ?? index}`}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="py-2 px-3">
                    <div className="font-medium">{row.patient_name ?? "Patient"}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {row.patient_uid}
                    </div>
                  </td>
                  <td className="py-2 px-3">{row.isolation_type ?? "—"}</td>
                  <td className="py-2 px-3">
                    {[row.ward, row.bed_number].filter(Boolean).join(" / ") ||
                      "—"}
                  </td>
                  <td className="py-2 px-3">{row.source ?? row.source_kind}</td>
                  <td className="py-2 px-3">
                    <StatusBadge
                      status={row.order_status ?? row.case_status ?? "active"}
                    />
                  </td>
                  <td className="py-2 px-3 text-right">
                    {row.isolation_order_id ? (
                      <button
                        onClick={() => requestTerminalClean(row.isolation_order_id as number | string)}
                        disabled={saving}
                        className="px-2 py-1 border border-border rounded-md text-xs hover:bg-muted disabled:opacity-50"
                      >
                        Clean
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {haiRates.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Indicator</th>
                <th className="py-2 px-3">Device</th>
                <th className="py-2 px-3">Cases</th>
                <th className="py-2 px-3">Denominator</th>
                <th className="py-2 px-3">Rate</th>
              </tr>
            </thead>
            <tbody>
              {haiRates.map((row) => (
                <tr key={row.hai_type} className="border-b border-border">
                  <td className="py-2 px-3 font-medium">{row.hai_type}</td>
                  <td className="py-2 px-3">{row.device_type ?? "—"}</td>
                  <td className="py-2 px-3">{row.numerator}</td>
                  <td className="py-2 px-3">{row.device_days}</td>
                  <td className="py-2 px-3">
                    {row.rate_per_1000_device_days == null
                      ? "—"
                      : Number(row.rate_per_1000_device_days).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ordering && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between">
              <h3 className="font-bold">Isolation Order</h3>
              <button
                onClick={() => setOrdering(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <input
              placeholder="Patient UID *"
              value={form.patient_uid}
              onChange={(e) =>
                setForm({ ...form, patient_uid: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Admission ID"
              value={form.admission_id}
              onChange={(e) =>
                setForm({ ...form, admission_id: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Infection case ID"
              value={form.infection_case_id}
              onChange={(e) =>
                setForm({ ...form, infection_case_id: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <select
              value={form.precaution_type}
              onChange={(e) =>
                setForm({ ...form, precaution_type: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {["standard", "contact", "droplet", "airborne", "protective", "enteric"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <textarea
              rows={2}
              placeholder="Reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setOrdering(false)}
                className="flex-1 py-2 border rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={createOrder}
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
