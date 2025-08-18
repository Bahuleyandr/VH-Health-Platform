export default function CleanDashboard() {
  "use client";
  
  // --- Imports kept inline to make this a single drop-in file ---
  // eslint-disable-next-line @next/next/no-document-import-in-page
  const React = require("react");
  const { useEffect, useMemo, useState } = React;
  const { API_ENDPOINTS, API_BASE_URL, getHeaders } = require("@/lib/api-config");

  // ---- Types ----
  type HealthStatus = "healthy" | "warning" | "critical";

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

  type DashboardResponse = {
    overview?: {
      totalUsers?: number;
      presentStaff?: number;
      availableDoctors?: number;
      appointmentsToday?: number;
    };
    charts?: {
      userGrowth?: Array<{ date: string; value: number }>;
      appointmentTrends?: Array<{ date: string; value: number }>;
      departmentUtilization?: Array<{ label: string; value: number }>;
    };
    recentActivity?: ActivityItem[];
    systemHealth?: {
      status: HealthStatus;
      uptime: string;
      responseTime: number; // ms
      errorRate: number; // %
    };
  };

  // ---- Local state ----
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quick, setQuick] = useState<Quick>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [health, setHealth] = useState<{ status: HealthStatus; uptime: string; responseTime: number; errorRate: number } | null>(null);
  const [charts, setCharts] = useState<{ labels: string[]; users: number[]; appts: number[] }>({ labels: [], users: [], appts: [] });

  // ---- Helpers ----
  const token = typeof window !== "undefined" ? localStorage.getItem("adminToken") ?? undefined : undefined;
  const headers = getHeaders(token);

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  async function post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  function pickQuick(from?: DashboardResponse["overview"]): Quick {
    return {
      totalUsers: from?.totalUsers ?? 0,
      presentStaff: from?.presentStaff ?? 0,
      availableDoctors: from?.availableDoctors ?? 0,
      appointmentsToday: from?.appointmentsToday ?? 0,
    };
  }

  function toTimeAgo(iso?: string) {
    if (!iso) return "just now";
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
  }

  // ---- Load data ----
  async function loadAll() {
    setLoading(true);
    try {
      // Dashboard bundle
      const dash: DashboardResponse = await get(API_ENDPOINTS.admin.dashboard);

      // Quick stats (cheap, but separate service in your API map)
      const quickStats = await get<{ data?: Quick; [k: string]: any }>(API_ENDPOINTS.admin.stats.quick).catch(() => null);

      // Recent activity
      const recent = await get<{ data?: ActivityItem[]; items?: ActivityItem[]; [k: string]: any }>(
        API_ENDPOINTS.admin.activity.recent + "?limit=10&offset=0"
      ).catch(() => null);

      // System health
      const sys = await get<{ data?: { status: HealthStatus; uptime: string; responseTime: number; errorRate: number } }>(
        API_ENDPOINTS.admin.health.system
      ).catch(() => null);

      // Normalize
      const overview = dash?.overview ?? {};
      setQuick({
        totalUsers: quickStats?.data?.totalUsers ?? overview.totalUsers ?? 0,
        presentStaff: overview.presentStaff ?? 0,
        availableDoctors: overview.availableDoctors ?? 0,
        appointmentsToday: overview.appointmentsToday ?? 0,
      });

      const ug = dash?.charts?.userGrowth ?? [];
      const at = dash?.charts?.appointmentTrends ?? [];
      setCharts({
        labels: ug.length ? ug.map((d) => d.date) : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        users: ug.length ? ug.map((d) => d.value) : [65, 78, 90, 81, 84, 78, 95],
        appts: at.length ? at.map((d) => d.value) : [58, 68, 77, 89, 76, 77, 88],
      });

      const act = recent?.data ?? recent?.items ?? dash?.recentActivity ?? [];
      setActivity(
        (act ?? []).slice(0, 10).map((a, i) => ({
          id: a.id ?? String(i),
          user: a.user ?? "System",
          action: a.action ?? "updated",
          target: a.target ?? "record",
          department: a.department,
          timestamp: a.timestamp ?? new Date().toISOString(),
        }))
      );

      setHealth(
        sys?.data ??
          dash?.systemHealth ?? {
            status: "healthy" as HealthStatus,
            uptime: "99.99%",
            responseTime: 45,
            errorRate: 0.1,
          }
      );
    } finally {
      setLoading(false);
    }
  }

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
    // Auto-refresh every 60s
    const t = setInterval(loadAll, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Derived UI helpers ----
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    if (h < 20) return "Good evening";
    return "Good night";
  }, []);

  const statCards = [
    { label: "Total Patients", value: quick.totalUsers ?? 0, icon: "🏥" },
    { label: "Staff on Duty", value: quick.presentStaff ?? 0, icon: "👥" },
    { label: "Available Doctors", value: quick.availableDoctors ?? 0, icon: "🩺" },
    { label: "Today's Appointments", value: quick.appointmentsToday ?? 0, icon: "📋" },
  ];

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
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={refreshCache}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
            >
              <span className={refreshing ? "animate-spin" : ""}>🔄</span>
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {/* Stats */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((s) => (
            <div key={s.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <span className="text-2xl" aria-hidden>{s.icon}</span>
              </div>
              <div className="mt-3">
                <p className="text-sm text-muted-foreground">{s.label}</p>
                <p className="mt-1 text-3xl font-bold tracking-tight">{(s.value ?? 0).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </section>

        {/* Charts + Activity */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chart card */}
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

          {/* Activity card */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">Recent Activity</h2>
            </div>
            <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
              {activity.map((a) => (
                <div key={a.id} className="rounded-lg bg-muted p-3">
                  <p className="text-sm">
                    <strong className="font-medium text-primary">{a.user}</strong> {a.action}{" "}
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

        {/* System health */}
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-semibold">System Health</h2>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                health?.status === "healthy"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                  : health?.status === "warning"
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                  : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
              }`}
            >
              <span className="text-lg" aria-hidden>
                {health?.status === "healthy" ? "✅" : health?.status === "warning" ? "⚠️" : "⛔"}
              </span>
              {health?.status ?? "healthy"}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <Metric label="Uptime" value={health?.uptime ?? "99.99%"} />
            <Metric label="Resp. Time" value={`${health?.responseTime ?? 45} ms`} />
            <Metric label="Error Rate" value={`${health?.errorRate ?? 0.1}%`} />
            <Metric label="Last Refresh" value={new Date().toLocaleTimeString()} />
          </div>
        </section>
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
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold">{value}</p>
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
              style={{ height: `${(a[i] ?? 0) / max * 100}%` }}
              title={`Users • ${a[i] ?? 0}`}
            />
            <div
              className="w-1/2 rounded bg-secondary/80"
              style={{ height: `${(b[i] ?? 0) / max * 100}%` }}
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
