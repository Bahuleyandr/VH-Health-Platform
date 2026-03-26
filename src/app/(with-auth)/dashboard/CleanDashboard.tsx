// src/app/(with-auth)/dashboard/CleanDashboard.tsx

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';

// ---- Types ----
type HealthStatus = 'healthy' | 'warning' | 'critical';

type Quick = {
  totalUsers?: number;
  presentStaff?: number;
  availableDoctors?: number;
  appointmentsToday?: number;
};

type ActivityItem = {
  id: string;
  user: string;
  action: string;
  target: string;
  department?: string;
  timestamp?: string;
};

type SystemHealth = {
  status: HealthStatus;
  uptime: string;
  responseTime: number; // ms
  errorRate: number; // %
  modules?: Array<{ name: string; status: HealthStatus }>;
};

type AppointmentQueue = {
  waiting: number;
  inProgress: number;
  completed: number;
};

type InfraHealthCheck = {
  status?: string;
  latency_ms?: number;
  error?: string;
  note?: string;
  pending?: number;
  sent?: number;
  failed_permanent?: number;
  appointments?: number;
  pharmacy?: number;
  investigations?: number;
  uptime_hours?: number;
  memory_mb?: number;
  memory_total_mb?: number;
  memory_percent?: number;
  node_version?: string;
  environment?: string;
  provider?: string;
};

type InfraHealthData = {
  status: string;
  timestamp: string;
  checks: Record<string, InfraHealthCheck>;
};

type DashboardResponse = {
  overview?: Quick;
  charts?: {
    userGrowth?: Array<{ date: string; value: number }>;
    appointmentTrends?: Array<{ date: string; value: number }>;
    departmentUtilization?: Array<{ label: string; value: number }>;
  };
  recentActivity?: ActivityItem[];
  systemHealth?: SystemHealth;
};

export default function CleanDashboard() {
  // ---- Local state ----
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quick, setQuick] = useState<Quick>({});
  const [prevQuick, setPrevQuick] = useState<Quick>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [charts, setCharts] = useState<{ labels: string[]; users: number[]; appts: number[] }>({ labels: [], users: [], appts: [] });
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [queue, setQueue] = useState<AppointmentQueue>({ waiting: 0, inProgress: 0, completed: 0 });
  const [prevQueue, setPrevQueue] = useState<AppointmentQueue>({ waiting: 0, inProgress: 0, completed: 0 });
  const [infraHealth, setInfraHealth] = useState<InfraHealthData | null>(null);

  // ---- Helpers ----
  const token = typeof window !== 'undefined' ? localStorage.getItem('adminToken') ?? undefined : undefined;
  const headers = getHeaders(token);
  const headersRef = useRef(headers);
  headersRef.current = headers;

  const get = useCallback(async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: headersRef.current });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }, []);

  const post = useCallback(async function post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...headersRef.current, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }, []);

  function toTimeAgo(iso?: string) {
    if (!iso) return 'just now';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
  }

  // ---- Live "seconds ago" ticker ----
  useEffect(() => {
    const t = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [lastUpdated]);

  // ---- Load data ----
  const loadAll = useCallback(async function loadAll() {
    setLoading(true);
    try {
      const dash = await get<DashboardResponse>(API_ENDPOINTS.admin.dashboard);
      const quickStats = await get<{ data?: Quick }>(API_ENDPOINTS.admin.stats.quick).catch(() => null);
      const recent = await get<{ data?: ActivityItem[]; items?: ActivityItem[] }>(
        API_ENDPOINTS.admin.activity.recent + '?limit=10&offset=0'
      ).catch(() => null);
      const sys = await get<{ data?: SystemHealth }>(API_ENDPOINTS.admin.health.system).catch(() => null);

      // Appointment stats for queue
      const apptStats = await get<{ data?: { waiting?: number; in_progress?: number; completed?: number; inProgress?: number } }>(
        API_ENDPOINTS.admin.stats.appointments
      ).catch(() => null);

      // Module health
      const moduleHealth = await get<{ data?: Array<{ name: string; status: HealthStatus }> }>(
        API_ENDPOINTS.admin.health.modules
      ).catch(() => null);

      // Infrastructure health (deep system check)
      const infraData = await get<{ data?: InfraHealthData }>('/system/health').catch(() => null);
      if (infraData?.data) {
        setInfraHealth(infraData.data);
      }

      // Normalize
      const overview = dash?.overview ?? {};
      const newQuick: Quick = {
        totalUsers: quickStats?.data?.totalUsers ?? overview.totalUsers ?? 0,
        presentStaff: overview.presentStaff ?? 0,
        availableDoctors: overview.availableDoctors ?? 0,
        appointmentsToday: overview.appointmentsToday ?? 0,
      };
      setPrevQuick(quick);
      setQuick(newQuick);

      // Queue
      const newQueue: AppointmentQueue = {
        waiting: apptStats?.data?.waiting ?? 0,
        inProgress: apptStats?.data?.inProgress ?? apptStats?.data?.in_progress ?? 0,
        completed: apptStats?.data?.completed ?? 0,
      };
      setPrevQueue(queue);
      setQueue(newQueue);

      const ug = dash?.charts?.userGrowth ?? [];
      const at = dash?.charts?.appointmentTrends ?? [];
      setCharts({
        labels: ug.length ? ug.map((d) => d.date) : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        users: ug.length ? ug.map((d) => d.value) : [65, 78, 90, 81, 84, 78, 95],
        appts: at.length ? at.map((d) => d.value) : [58, 68, 77, 89, 76, 77, 88],
      });

      const act = recent?.data ?? recent?.items ?? dash?.recentActivity ?? [];
      setActivity(
        (act ?? []).slice(0, 10).map((a, i) => ({
          id: a?.id ?? String(i),
          user: a?.user ?? 'System',
          action: a?.action ?? 'updated',
          target: a?.target ?? 'record',
          department: a?.department,
          timestamp: a?.timestamp ?? new Date().toISOString(),
        }))
      );

      const healthData = sys?.data ??
        dash?.systemHealth ?? {
          status: 'healthy' as HealthStatus,
          uptime: '99.99%',
          responseTime: 45,
          errorRate: 0.1,
        };

      // Merge module health
      if (moduleHealth?.data) {
        healthData.modules = moduleHealth.data;
      }

      setHealth(healthData);
      setLastUpdated(new Date());
      setSecondsAgo(0);
    } finally {
      setLoading(false);
    }
  }, [get, quick, queue]);

  async function refreshCache() {
    setRefreshing(true);
    try {
      await post(API_ENDPOINTS.admin.reports.refreshCache);
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 30_000); // 30s refresh
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentional: run once on mount

  // ---- Derived UI helpers ----
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 20) return 'Good evening';
    return 'Good night';
  }, []);

  function getMetricStatus(current?: number, label?: string): HealthStatus {
    if (label === 'Available Doctors' && (current ?? 0) === 0) return 'critical';
    if (label === 'Available Doctors' && (current ?? 0) < 3) return 'warning';
    if (label === 'Staff on Duty' && (current ?? 0) === 0) return 'critical';
    if (label === 'Staff on Duty' && (current ?? 0) < 5) return 'warning';
    return 'healthy';
  }

  function trendArrow(current: number, previous: number): string {
    if (current > previous) return '↑';
    if (current < previous) return '↓';
    return '';
  }

  const statCards = [
    { label: 'Total Patients', value: quick.totalUsers ?? 0, prev: prevQuick.totalUsers ?? 0, icon: '🏥' },
    { label: 'Staff on Duty', value: quick.presentStaff ?? 0, prev: prevQuick.presentStaff ?? 0, icon: '👥' },
    { label: 'Available Doctors', value: quick.availableDoctors ?? 0, prev: prevQuick.availableDoctors ?? 0, icon: '🩺' },
    { label: "Today's Appointments", value: quick.appointmentsToday ?? 0, prev: prevQuick.appointmentsToday ?? 0, icon: '📋' },
  ];

  const statusDotColor = (s: HealthStatus) =>
    s === 'healthy' ? '#22c55e' : s === 'warning' ? '#eab308' : '#ef4444';

  const healthBarColor = (value: number, thresholds: [number, number]) =>
    value <= thresholds[0] ? '#22c55e' : value <= thresholds[1] ? '#eab308' : '#ef4444';

  // ---- UI ----
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40 text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3 justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{greeting}, Admin</h1>
            <p className="text-sm text-muted-foreground">
              {new Date().toLocaleDateString(undefined, {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Live indicator badge */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: secondsAgo < 35 ? '#22c55e' : secondsAgo < 60 ? '#eab308' : '#ef4444',
                  animation: 'pulse 2s infinite',
                }}
              />
              Updated {secondsAgo < 5 ? 'just now' : `${secondsAgo}s ago`}
            </span>

            <button
              onClick={refreshCache}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
            >
              <span className={refreshing ? 'animate-spin' : ''}>🔄</span>
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {/* Stats */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((s) => {
            const status = getMetricStatus(s.value, s.label);
            const arrow = trendArrow(s.value, s.prev);
            return (
              <div key={s.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between">
                  <span className="text-2xl" aria-hidden>{s.icon}</span>
                  <span
                    className="h-3 w-3 rounded-full mt-1"
                    style={{ backgroundColor: statusDotColor(status) }}
                    title={status}
                  />
                </div>
                <div className="mt-3">
                  <p className="text-sm text-muted-foreground">{s.label}</p>
                  <p className="mt-1 text-3xl font-bold tracking-tight">
                    {(s.value ?? 0).toLocaleString()}
                    {arrow && (
                      <span className={`ml-1 text-lg ${arrow === '↑' ? 'text-emerald-500' : 'text-destructive'}`}>
                        {arrow}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            );
          })}
        </section>

        {/* Appointment Queue */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: 'Waiting', value: queue.waiting, prev: prevQueue.waiting, color: '#eab308', bg: 'rgba(234,179,8,0.1)' },
            { label: 'In Progress', value: queue.inProgress, prev: prevQueue.inProgress, color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
            { label: 'Completed', value: queue.completed, prev: prevQueue.completed, color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
          ].map((q) => {
            const arrow = trendArrow(q.value, q.prev);
            return (
              <div key={q.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: q.color }} />
                  <span className="text-sm font-medium text-muted-foreground">Queue: {q.label}</span>
                </div>
                <p className="text-2xl font-bold">
                  {q.value}
                  {arrow && (
                    <span className={`ml-1 text-base ${arrow === '↑' ? 'text-amber-500' : 'text-emerald-500'}`}>
                      {arrow}
                    </span>
                  )}
                </p>
              </div>
            );
          })}
        </section>

        {/* Charts + Activity */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">Analytics Overview</h2>
              <div className="flex items-center gap-2">
                <select className="rounded-md border border-border bg-background px-2 py-1 text-sm">
                  <option>Last 7 days</option>
                  <option>Last 30 days</option>
                  <option>Last 3 months</option>
                </select>
              </div>
            </div>
            <MiniBars labels={charts.labels} a={charts.users} b={charts.appts} />
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">Recent Activity</h2>
            </div>
            <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
              {activity.map((a) => (
                <div key={a.id} className="rounded-lg bg-muted p-3">
                  <p className="text-sm">
                    <strong className="font-medium text-primary">{a.user}</strong> {a.action}{' '}
                    <em className="not-italic text-foreground/90">{a.target}</em>
                  </p>
                  <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
                    {a.department ? <span className="rounded bg-background/60 px-1.5 py-0.5">{a.department}</span> : null}
                    <span>{toTimeAgo(a.timestamp)}</span>
                  </div>
                </div>
              ))}
              {activity.length === 0 && (
                <p className="text-sm text-muted-foreground">No recent activity.</p>
              )}
            </div>
          </div>
        </section>

        {/* System Health Panel */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">System Health</h2>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                health?.status === 'healthy'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : health?.status === 'warning'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-destructive/10 text-destructive dark:bg-destructive/40 dark:text-destructive/70'
              }`}
            >
              <span className="text-base" aria-hidden>
                {health?.status === 'healthy' ? '✅' : health?.status === 'warning' ? '⚠️' : '⛔'}
              </span>
              {health?.status ?? 'healthy'}
            </span>
          </div>

          {/* Gauge bars */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <GaugeBar
              label="Uptime"
              value={parseFloat(health?.uptime?.replace('%', '') ?? '99.99')}
              max={100}
              unit="%"
              color={healthBarColor(100 - parseFloat(health?.uptime?.replace('%', '') ?? '99.99'), [1, 5])}
            />
            <GaugeBar
              label="Response Time"
              value={health?.responseTime ?? 45}
              max={500}
              unit="ms"
              color={healthBarColor(health?.responseTime ?? 45, [100, 300])}
            />
            <GaugeBar
              label="Error Rate"
              value={health?.errorRate ?? 0.1}
              max={10}
              unit="%"
              color={healthBarColor(health?.errorRate ?? 0.1, [1, 5])}
            />
          </div>

          {/* Module health indicators */}
          {health?.modules && health.modules.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">Module Health</h3>
              <div className="flex flex-wrap gap-2">
                {health.modules.map((m) => (
                  <span
                    key={m.name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: statusDotColor(m.status) }}
                    />
                    {m.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 text-xs text-muted-foreground">
            Last refresh: {lastUpdated.toLocaleTimeString()} · Auto-refresh every 30s
          </div>
        </section>

        {/* Infrastructure Health (deep check from /system/health) */}
        {infraHealth && (
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Infrastructure Monitor</h2>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                  infraHealth.status === 'healthy'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                }`}
              >
                {infraHealth.status === 'healthy' ? '✅ All Systems Go' : '⚠️ Degraded'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <InfraCard
                label="Database"
                status={infraHealth.checks.database?.status}
                detail={infraHealth.checks.database?.latency_ms != null ? `${infraHealth.checks.database.latency_ms}ms` : undefined}
              />
              <InfraCard
                label="R2 Storage"
                status={infraHealth.checks.r2_storage?.status}
                detail={infraHealth.checks.r2_storage?.note}
              />
              <InfraCard
                label="Push Notifications"
                status={infraHealth.checks.push_notifications?.status}
              />
              <InfraCard
                label="SMS"
                status={infraHealth.checks.sms?.status}
                detail={infraHealth.checks.sms?.provider}
              />
              <InfraCard
                label="Scheduler"
                status={infraHealth.checks.scheduler?.status}
              />
              {infraHealth.checks.notification_backlog && (
                <InfraCard
                  label="Notification Backlog"
                  status={
                    (infraHealth.checks.notification_backlog.pending ?? 0) > 10
                      ? 'warning'
                      : 'healthy'
                  }
                  detail={`${infraHealth.checks.notification_backlog.pending ?? 0} pending`}
                />
              )}
              {infraHealth.checks.stuck_orders && (
                <InfraCard
                  label="Stuck Orders"
                  status={
                    ((infraHealth.checks.stuck_orders.appointments ?? 0) +
                      (infraHealth.checks.stuck_orders.pharmacy ?? 0) +
                      (infraHealth.checks.stuck_orders.investigations ?? 0)) > 0
                      ? 'warning'
                      : 'healthy'
                  }
                  detail={`${infraHealth.checks.stuck_orders.appointments ?? 0} appt / ${infraHealth.checks.stuck_orders.pharmacy ?? 0} pharm / ${infraHealth.checks.stuck_orders.investigations ?? 0} inv`}
                />
              )}
              {infraHealth.checks.server && (
                <InfraCard
                  label="Server"
                  status="healthy"
                  detail={`${infraHealth.checks.server.uptime_hours}h uptime · ${infraHealth.checks.server.memory_mb}MB`}
                />
              )}
            </div>
          </section>
        )}
      </main>

      {/* Loading overlay */}
      {loading && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-background/60 backdrop-blur">
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-6 py-5 shadow-sm">
            <div className="text-3xl">🏥</div>
            <p className="text-sm text-muted-foreground">Loading dashboard…</p>
          </div>
        </div>
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

// ---- Gauge Bar Component ----
function GaugeBar({ label, value, max, unit, color }: { label: string; value: number; max: number; unit: string; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="rounded-lg bg-muted p-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold">{value}{unit}</p>
      </div>
      <div className="h-2 w-full rounded-full bg-background/60 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

// ---- Infrastructure Health Card ----
function InfraCard({ label, status, detail }: { label: string; status?: string; detail?: string }) {
  const isHealthy = status === 'healthy' || status === 'configured' || status === 'running';
  const isDegraded = status === 'degraded' || status === 'warning' || status === 'dry_run' || status === 'not_initialized';
  const isDown = status === 'down';

  const dotColor = isHealthy ? '#22c55e' : isDegraded ? '#eab308' : isDown ? '#ef4444' : '#6b7280';
  const emoji = isHealthy ? '✅' : isDegraded ? '⚠️' : isDown ? '⛔' : '❓';

  return (
    <div className="rounded-lg border border-border bg-muted/50 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dotColor }} />
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs ml-auto">{emoji}</span>
      </div>
      <p className="text-xs text-muted-foreground">{status ?? 'unknown'}</p>
      {detail && <p className="text-xs text-muted-foreground/70 mt-0.5">{detail}</p>}
    </div>
  );
}

// Tiny bar chart without external deps
function MiniBars({ labels, a, b }: { labels: string[]; a: number[]; b: number[] }) {
  const max = Math.max(1, ...a, ...b);
  return (
    <div className="mt-2">
      <div className="grid grid-cols-7 gap-2 h-48 items-end">
        {labels.map((lbl, i) => (
          <div key={lbl} className="flex h-full w-full items-end gap-1">
            <div
              className="w-1/2 rounded bg-primary/80"
              style={{ height: `${((a[i] ?? 0) / max) * 100}%` }}
              title={`Users • ${a[i] ?? 0}`}
            />
            <div
              className="w-1/2 rounded bg-secondary/80"
              style={{ height: `${((b[i] ?? 0) / max) * 100}%` }}
              title={`Appointments • ${b[i] ?? 0}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-primary/80" /> Users</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-secondary/80" /> Appointments</span>
      </div>
    </div>
  );
}
