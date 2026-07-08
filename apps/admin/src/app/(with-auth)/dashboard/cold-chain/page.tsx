"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Download,
  Plus,
  RefreshCw,
  Thermometer,
} from "lucide-react";
import { toast } from "react-hot-toast";

import { fetchAdminAPI, postJSON } from "@/lib/api";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";

type ColdChainUnit = {
  id: number;
  unit_code: string;
  display_name: string;
  kind: string;
  department: string;
  device_registry_id: number;
  device_code?: string | null;
  device_name?: string | null;
  min_temp_c: number | string;
  max_temp_c: number | string;
  excursion_grace_minutes: number;
  alert_roles: string[];
  status: string;
  last_seen_at?: string | null;
  expected_interval_seconds?: number | null;
  latest_temp_c?: number | string | null;
  latest_recorded_at?: string | null;
  open_excursion_id?: number | null;
  open_excursion_severity?: string | null;
  open_excursion_status?: string | null;
};

type ColdChainExcursion = {
  id: number;
  unit_id: number;
  unit_code?: string;
  display_name?: string;
  department?: string;
  opened_at: string;
  breach_started_at: string;
  returned_in_range_at?: string | null;
  peak_temp_c?: number | string | null;
  severity: "warning" | "critical";
  status: "open" | "acknowledged" | "closed";
  corrective_action?: string | null;
  disposition_note?: string | null;
};

type ColdChainReviewFlag = {
  id: number;
  excursion_id: number;
  unit_code?: string;
  display_name?: string;
  severity?: string;
  opened_at?: string;
};

type ColdChainDashboard = {
  units?: ColdChainUnit[];
  excursions?: ColdChainExcursion[];
  recent_readings?: Array<Record<string, unknown>>;
  blood_bank_review_flags?: ColdChainReviewFlag[];
};

type ClinicalDevice = {
  id: number;
  device_code: string;
  display_name: string;
  kind: string;
  status: string;
};

const COLD_CHAIN_CHANNEL = "staff:cold-chain";
const todayMonth = new Date().toISOString().slice(0, 7);
const EMPTY_UNITS: ColdChainUnit[] = [];
const EMPTY_EXCURSIONS: ColdChainExcursion[] = [];
const EMPTY_REVIEW_FLAGS: ColdChainReviewFlag[] = [];

function dateTime(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function temp(value?: number | string | null) {
  if (value === null || value === undefined || value === "") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(1)} C` : String(value);
}

function statusClass(status?: string | null, severity?: string | null) {
  if (status === "closed") return "border-green-200 bg-green-50 text-green-700";
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700";
  if (status === "acknowledged") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function exportRegister(unitId: number, month: string, format: "csv" | "pdf") {
  const qs = new URLSearchParams({ month, format });
  window.open(`/api/proxy/api/v1/cold-chain/units/${unitId}/register?${qs.toString()}`, "_blank", "noopener,noreferrer");
}

export default function ColdChainPage() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(todayMonth);
  const [corrective, setCorrective] = useState<Record<number, { corrective_action: string; disposition_note: string }>>({});
  const [form, setForm] = useState({
    unit_code: "",
    display_name: "",
    kind: "fridge",
    department: "pharmacy",
    device_registry_id: "",
    min_temp_c: "2",
    max_temp_c: "8",
    excursion_grace_minutes: "15",
    alert_roles: "PHARMACY_STAFF,PHARMACY_INCHARGE",
  });

  const realtime = useRealtimeInvalidation(COLD_CHAIN_CHANNEL, [["cold-chain"]]);

  const dashboardQuery = useQuery({
    queryKey: ["cold-chain"],
    queryFn: () => fetchAdminAPI<ColdChainDashboard>("/cold-chain/dashboard"),
    refetchInterval: 60000,
  });

  const devicesQuery = useQuery({
    queryKey: ["clinical-device-registry", "fridge_sensor"],
    queryFn: async () => {
      const result = await fetchAdminAPI<{ devices?: ClinicalDevice[] }>("/devices/registry?kind=fridge_sensor&status=active");
      return result.devices ?? [];
    },
  });

  const dashboard = dashboardQuery.data ?? {};
  const units = dashboard.units ?? EMPTY_UNITS;
  const excursions = dashboard.excursions ?? EMPTY_EXCURSIONS;
  const reviewFlags = dashboard.blood_bank_review_flags ?? EMPTY_REVIEW_FLAGS;

  const summary = useMemo(() => ({
    units: units.length,
    open: excursions.filter((item) => item.status === "open").length,
    critical: excursions.filter((item) => item.severity === "critical").length,
    silent: units.filter((unit) => {
      if (!unit.last_seen_at || !unit.expected_interval_seconds) return unit.status === "active";
      return Date.now() - new Date(unit.last_seen_at).getTime() > unit.expected_interval_seconds * 3000;
    }).length,
  }), [units, excursions]);

  const createUnit = useMutation({
    mutationFn: () => postJSON("/api/v1/cold-chain/units", {
      ...form,
      device_registry_id: Number(form.device_registry_id),
      min_temp_c: Number(form.min_temp_c),
      max_temp_c: Number(form.max_temp_c),
      excursion_grace_minutes: Number(form.excursion_grace_minutes),
      alert_roles: form.alert_roles.split(",").map((role) => role.trim()).filter(Boolean),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cold-chain"] });
      toast.success("Cold-chain unit created");
      setForm((prev) => ({ ...prev, unit_code: "", display_name: "", device_registry_id: "" }));
    },
    onError: (err: Error) => toast.error(err.message || "Failed to create unit"),
  });

  const acknowledge = useMutation({
    mutationFn: (id: number) => postJSON(`/api/v1/cold-chain/excursions/${id}/acknowledge`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cold-chain"] }),
    onError: (err: Error) => toast.error(err.message || "Failed to acknowledge"),
  });

  const recordAction = useMutation({
    mutationFn: (id: number) => postJSON(`/api/v1/cold-chain/excursions/${id}/corrective-action`, corrective[id]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cold-chain"] });
      toast.success("Corrective action recorded");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to record corrective action"),
  });

  const runWatchdog = useMutation({
    mutationFn: () => postJSON("/api/v1/cold-chain/watchdog/run", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cold-chain"] });
      toast.success("Watchdog sweep completed");
    },
    onError: (err: Error) => toast.error(err.message || "Watchdog sweep failed"),
  });

  return (
    <main className="space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Cold Chain</h1>
          <p className="text-sm text-muted-foreground">Facility temperature monitoring, excursions, and monthly registers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="cold-chain-realtime-indicator"
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              realtime.subscribed ? "border-green-200 bg-green-50 text-green-700" : "border-slate-200 bg-slate-50 text-slate-600"
            }`}
          >
            {realtime.subscribed ? "Live" : "Offline"}
          </span>
          <button
            type="button"
            onClick={() => dashboardQuery.refetch()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => runWatchdog.mutate()}
            disabled={runWatchdog.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <BellRing className="h-4 w-4" />
            Watchdog
          </button>
        </div>
      </div>

      <section className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Thermometer className="h-4 w-4" /> Units</div>
          <p className="mt-2 text-2xl font-semibold">{summary.units}</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Activity className="h-4 w-4" /> Open</div>
          <p className="mt-2 text-2xl font-semibold">{summary.open}</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><AlertTriangle className="h-4 w-4" /> Critical</div>
          <p className="mt-2 text-2xl font-semibold text-red-600">{summary.critical}</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><BellRing className="h-4 w-4" /> Silent</div>
          <p className="mt-2 text-2xl font-semibold text-amber-600">{summary.silent}</p>
        </div>
      </section>

      <section className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Provision Unit</h2>
          <span className="text-xs text-muted-foreground">{devicesQuery.data?.length ?? 0} active fridge sensors</span>
        </div>
        <div className="grid gap-3 md:grid-cols-8">
          <input className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Unit code" value={form.unit_code} onChange={(event) => setForm((prev) => ({ ...prev, unit_code: event.target.value }))} />
          <input className="rounded-md border border-border bg-background px-3 py-2 text-sm md:col-span-2" placeholder="Display name" value={form.display_name} onChange={(event) => setForm((prev) => ({ ...prev, display_name: event.target.value }))} />
          <select className="rounded-md border border-border bg-background px-3 py-2 text-sm" value={form.device_registry_id} onChange={(event) => setForm((prev) => ({ ...prev, device_registry_id: event.target.value }))}>
            <option value="">Sensor</option>
            {(devicesQuery.data ?? []).map((device) => (
              <option key={device.id} value={device.id}>{device.device_code}</option>
            ))}
          </select>
          <select className="rounded-md border border-border bg-background px-3 py-2 text-sm" value={form.department} onChange={(event) => setForm((prev) => ({ ...prev, department: event.target.value }))}>
            <option value="pharmacy">Pharmacy</option>
            <option value="blood_bank">Blood bank</option>
            <option value="lab">Lab</option>
            <option value="ward">Ward</option>
            <option value="ot">OT</option>
          </select>
          <select className="rounded-md border border-border bg-background px-3 py-2 text-sm" value={form.kind} onChange={(event) => setForm((prev) => ({ ...prev, kind: event.target.value }))}>
            <option value="fridge">Fridge</option>
            <option value="freezer">Freezer</option>
            <option value="ilr">ILR</option>
            <option value="ambient">Ambient</option>
          </select>
          <div className="grid grid-cols-3 gap-2 md:col-span-2">
            <input className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Min" value={form.min_temp_c} onChange={(event) => setForm((prev) => ({ ...prev, min_temp_c: event.target.value }))} />
            <input className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Max" value={form.max_temp_c} onChange={(event) => setForm((prev) => ({ ...prev, max_temp_c: event.target.value }))} />
            <input className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Grace" value={form.excursion_grace_minutes} onChange={(event) => setForm((prev) => ({ ...prev, excursion_grace_minutes: event.target.value }))} />
          </div>
          <input className="rounded-md border border-border bg-background px-3 py-2 text-sm md:col-span-6" placeholder="Alert roles" value={form.alert_roles} onChange={(event) => setForm((prev) => ({ ...prev, alert_roles: event.target.value }))} />
          <button
            type="button"
            disabled={createUnit.isPending || !form.unit_code || !form.display_name || !form.device_registry_id}
            onClick={() => createUnit.mutate()}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 md:col-span-2"
          >
            <Plus className="h-4 w-4" />
            Add Unit
          </button>
        </div>
      </section>

      {dashboardQuery.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {dashboardQuery.error instanceof Error ? dashboardQuery.error.message : "Failed to load cold-chain dashboard"}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Open Excursions</h2>
          <span className="text-xs text-muted-foreground">{reviewFlags.length} blood-bank review flags</span>
        </div>
        {excursions.length === 0 && !dashboardQuery.isLoading && (
          <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">No open excursions</div>
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          {excursions.map((excursion) => {
            const draft = corrective[excursion.id] ?? { corrective_action: "", disposition_note: "" };
            return (
              <article key={excursion.id} className={`rounded-lg border p-4 ${statusClass(excursion.status, excursion.severity)}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{excursion.display_name ?? excursion.unit_code ?? `Unit ${excursion.unit_id}`}</h3>
                    <p className="text-xs opacity-80">Opened {dateTime(excursion.opened_at)} from breach {dateTime(excursion.breach_started_at)}</p>
                  </div>
                  <span className="rounded-md border border-current px-2 py-1 text-xs font-medium uppercase">{excursion.severity}</span>
                </div>
                <div className="mt-3 grid gap-2 text-sm md:grid-cols-3">
                  <span>Peak {temp(excursion.peak_temp_c)}</span>
                  <span>Status {excursion.status}</span>
                  <span>Returned {dateTime(excursion.returned_in_range_at)}</span>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <textarea
                    rows={2}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    placeholder="Corrective action"
                    value={draft.corrective_action}
                    onChange={(event) => setCorrective((prev) => ({ ...prev, [excursion.id]: { ...draft, corrective_action: event.target.value } }))}
                  />
                  <textarea
                    rows={2}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    placeholder="Disposition note"
                    value={draft.disposition_note}
                    onChange={(event) => setCorrective((prev) => ({ ...prev, [excursion.id]: { ...draft, disposition_note: event.target.value } }))}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => acknowledge.mutate(excursion.id)}
                    disabled={acknowledge.isPending || excursion.status === "acknowledged"}
                    className="inline-flex items-center gap-2 rounded-md border border-current px-3 py-2 text-sm font-medium disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Acknowledge
                  </button>
                  <button
                    type="button"
                    onClick={() => recordAction.mutate(excursion.id)}
                    disabled={recordAction.isPending || !draft.corrective_action.trim()}
                    className="inline-flex items-center gap-2 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                  >
                    Record Action
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-border">
        <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
          <h2 className="text-base font-semibold">Units</h2>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Month
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium text-muted-foreground">Unit</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Sensor</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Range</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Latest</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Last Seen</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Register</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {units.map((unit) => (
                <tr key={unit.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{unit.display_name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{unit.unit_code} - {unit.department}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{unit.device_name ?? "-"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{unit.device_code ?? "-"}</div>
                  </td>
                  <td className="px-4 py-3">{temp(unit.min_temp_c)} to {temp(unit.max_temp_c)}</td>
                  <td className="px-4 py-3">
                    <div className={unit.open_excursion_id ? "font-medium text-red-600" : "font-medium"}>{temp(unit.latest_temp_c)}</div>
                    <div className="text-xs text-muted-foreground">{dateTime(unit.latest_recorded_at)}</div>
                  </td>
                  <td className="px-4 py-3">{dateTime(unit.last_seen_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => exportRegister(unit.id, month, "csv")} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent">
                        <Download className="h-3.5 w-3.5" />
                        CSV
                      </button>
                      <button type="button" onClick={() => exportRegister(unit.id, month, "pdf")} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent">
                        <Download className="h-3.5 w-3.5" />
                        PDF
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {units.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    {dashboardQuery.isLoading ? "Loading units..." : "No cold-chain units configured"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
