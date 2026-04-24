// src/app/(with-auth)/dashboard/sos/page.tsx
//
// SOS / emergency dashboard. Reads the four admin SOS endpoints:
//   - getSosAnalytics       → totals + severity breakdown + 7-day trend
//   - getSosPerformanceReport → acknowledgement + resolution timings
//   - getEmergencyServices  → configured external services (police, ambulance)
//   - listSosAlerts         → most recent alerts for the on-call view
//
// Raw JSON dumps were the placeholder while the backend surface settled. This
// page now renders tiles + small tables and exposes the broadcast action at
// the bottom; any unexpected response shape falls back to "—".
"use client";

import { useCallback, useEffect, useState } from "react";
import { adminService } from "@/services/admin.service";

type Analytics = {
  totalAlerts?: number;
  activeAlerts?: number;
  resolvedAlerts?: number;
  testAlerts?: number;
  severityCounts?: { high?: number; medium?: number; low?: number };
  last24Hours?: number;
  last7Days?: { date: string; count: number }[];
};

type Performance = {
  averageAckMs?: number;
  averageResolveMs?: number;
  p95AckMs?: number;
  p95ResolveMs?: number;
  totalResolved?: number;
};

type EmergencyService = {
  id?: number | string;
  name?: string;
  kind?: string;
  phone?: string;
  enabled?: boolean;
};

type Alert = {
  id?: number | string;
  severity?: string;
  status?: string;
  message?: string;
  patient_name?: string;
  created_at?: string;
};

function unwrap<T>(x: unknown): T | null {
  if (x && typeof x === "object" && "data" in x) {
    return ((x as { data: unknown }).data as T) ?? null;
  }
  return (x as T) ?? null;
}

function fmtMs(ms?: number) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function SosPage() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [perf, setPerf] = useState<Performance | null>(null);
  const [services, setServices] = useState<EmergencyService[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [msg, setMsg] = useState<string>("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [a, p, s, al] = await Promise.all([
        adminService.getSosAnalytics(),
        adminService.getSosPerformanceReport(),
        adminService.getEmergencyServices(),
        adminService.listSosAlerts({ limit: 20, offset: 0 }),
      ]);
      setAnalytics(unwrap<Analytics>(a) ?? {});
      setPerf(unwrap<Performance>(p) ?? {});
      const servicesPayload = unwrap<EmergencyService[] | { items?: EmergencyService[] }>(s);
      setServices(
        Array.isArray(servicesPayload)
          ? servicesPayload
          : (servicesPayload && "items" in servicesPayload ? servicesPayload.items ?? [] : []),
      );
      const alertsPayload = unwrap<Alert[] | { items?: Alert[] }>(al);
      setAlerts(
        Array.isArray(alertsPayload)
          ? alertsPayload
          : (alertsPayload && "items" in alertsPayload ? alertsPayload.items ?? [] : []),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const broadcast = useCallback(async () => {
    if (!msg.trim()) return;
    setBroadcasting(true);
    try {
      await adminService.broadcastSosAlert({ message: msg.trim() });
      setBroadcastMsg("Broadcast sent.");
      setMsg("");
      await refresh();
    } catch (e) {
      setBroadcastMsg(e instanceof Error ? `Broadcast failed: ${e.message}` : "Broadcast failed");
    } finally {
      setBroadcasting(false);
    }
  }, [msg, refresh]);

  const severity = analytics?.severityCounts ?? {};

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold text-white">SOS / Emergency</h1>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-white hover:border-indigo-500 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total alerts" value={analytics?.totalAlerts ?? 0} />
        <StatTile label="Active" value={analytics?.activeAlerts ?? 0} tone={(analytics?.activeAlerts ?? 0) > 0 ? "red" : "emerald"} />
        <StatTile label="Resolved" value={analytics?.resolvedAlerts ?? 0} tone="emerald" />
        <StatTile label="Last 24h" value={analytics?.last24Hours ?? 0} tone={(analytics?.last24Hours ?? 0) > 0 ? "amber" : "white"} />
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Severity breakdown</h2>
        <div className="flex gap-2 text-xs">
          <SeverityPill label="High" value={severity.high ?? 0} tone="red" />
          <SeverityPill label="Medium" value={severity.medium ?? 0} tone="amber" />
          <SeverityPill label="Low" value={severity.low ?? 0} tone="emerald" />
          <SeverityPill label="Test alerts" value={analytics?.testAlerts ?? 0} tone="muted" />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Response performance</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
          <MiniStat label="Avg ack" value={fmtMs(perf?.averageAckMs)} />
          <MiniStat label="p95 ack" value={fmtMs(perf?.p95AckMs)} />
          <MiniStat label="Avg resolve" value={fmtMs(perf?.averageResolveMs)} />
          <MiniStat label="p95 resolve" value={fmtMs(perf?.p95ResolveMs)} />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Trailing 7 days</h2>
        {(analytics?.last7Days ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No alerts in the last 7 days.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr><Th>Date</Th><Th>Alerts</Th></tr>
            </thead>
            <tbody>
              {(analytics?.last7Days ?? []).map((d) => (
                <tr key={d.date} className="border-t border-border">
                  <Td>{d.date}</Td>
                  <Td>{d.count}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Emergency services</h2>
        {services.length === 0 ? (
          <p className="text-sm text-muted-foreground">No services configured.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr><Th>Name</Th><Th>Kind</Th><Th>Phone</Th><Th>Enabled</Th></tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id ?? s.name ?? Math.random()} className="border-t border-border">
                  <Td>{s.name ?? "—"}</Td>
                  <Td>{s.kind ?? "—"}</Td>
                  <Td>{s.phone ?? "—"}</Td>
                  <Td>{s.enabled ? "yes" : "no"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Recent alerts</h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent alerts.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr><Th>When</Th><Th>Severity</Th><Th>Status</Th><Th>Patient</Th><Th>Message</Th></tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id ?? Math.random()} className="border-t border-border">
                  <Td>{fmtDate(a.created_at)}</Td>
                  <Td>{a.severity ?? "—"}</Td>
                  <Td>{a.status ?? "—"}</Td>
                  <Td>{a.patient_name ?? "—"}</Td>
                  <Td>{a.message ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="font-semibold text-white">Broadcast emergency alert</h2>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm text-white"
            placeholder="Broadcast message…"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
          />
          <button
            onClick={() => void broadcast()}
            disabled={broadcasting || !msg.trim()}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {broadcasting ? "Sending…" : "Broadcast"}
          </button>
        </div>
        {broadcastMsg && <p className="text-xs text-muted-foreground">{broadcastMsg}</p>}
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "amber" | "red" | "emerald" | "white" }) {
  const colour =
    tone === "red" ? "text-red-400"
    : tone === "amber" ? "text-amber-400"
    : tone === "emerald" ? "text-emerald-400"
    : "text-white";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${colour}`}>{value}</p>
    </div>
  );
}

function SeverityPill({ label, value, tone }: { label: string; value: number; tone: "red" | "amber" | "emerald" | "muted" }) {
  const bg =
    tone === "red" ? "bg-red-500/15 text-red-400 border-red-500/30"
    : tone === "amber" ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : tone === "emerald" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : "bg-muted text-muted-foreground border-border";
  return (
    <span className={`rounded-full border px-3 py-1 font-medium ${bg}`}>
      {label}: {value}
    </span>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-lg font-bold text-white">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 text-left font-medium">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 text-white/90">{children}</td>;
}
