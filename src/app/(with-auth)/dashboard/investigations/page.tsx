// src/app/(with-auth)/dashboard/investigations/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "react-hot-toast";
import {
  getSLADashboard,
  getInvestigationsList,
  getTestCatalog,
  upsertTestCatalog,
  updateInvestigationStatus,
  getBookingQueue,
  getBookingSLA,
  confirmBooking,
  dispatchCollectorBooking,
  markBookingCollected,
  startBookingProcessing,
  uploadBookingResult,
  type Investigation,
  type TestCatalogItem,
  type SLADashboard,
  type InvestigationBooking,
  type BookingSLADashboard,
} from "@/lib/api/investigations";

/* ─── Helpers ─── */

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d;
  }
}

function priorityColor(p: string) {
  const u = p?.toUpperCase();
  if (u === "URGENT" || u === "STAT") return "bg-red-100 text-red-800";
  if (u === "HIGH") return "bg-orange-100 text-orange-800";
  return "bg-gray-100 text-gray-700";
}

function statusColor(s: string) {
  const u = s?.toUpperCase();
  if (u === "COMPLETED" || u === "RESULT_READY") return "bg-green-100 text-green-800";
  if (u === "PENDING") return "bg-yellow-100 text-yellow-800";
  if (u === "IN_PROGRESS") return "bg-blue-100 text-blue-800";
  if (u === "CANCELLED") return "bg-gray-200 text-gray-500";
  return "bg-gray-100 text-gray-700";
}

function Chip({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

/* ─── Tabs ─── */

const TABS = ["Overview", "All Investigations", "Test Catalog", "Notifications", "Lab Bookings"] as const;
type Tab = (typeof TABS)[number];

/* ─── Main Page ─── */

export default function InvestigationsPage() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Investigations</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "Overview" && <OverviewTab />}
      {tab === "All Investigations" && <AllInvestigationsTab />}
      {tab === "Test Catalog" && <TestCatalogTab />}
      {tab === "Notifications" && <NotificationsTab />}
      {tab === "Lab Bookings" && <LabBookingsTab />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 * OVERVIEW TAB
 * ════════════════════════════════════════════════════════════ */

function OverviewTab() {
  const [dashboard, setDashboard] = useState<SLADashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return d.toISOString().split("T")[0];
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().split("T")[0]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getSLADashboard(fromDate, toDate);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = res as any;
      const data = raw?.data ?? raw;
      setDashboard(data as SLADashboard);
    } catch {
      toast.error("Failed to load SLA dashboard");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="py-12 text-center text-muted-foreground">Loading dashboard…</div>;
  if (!dashboard) return <div className="py-12 text-center text-muted-foreground">No data</div>;

  const s = dashboard.summary;

  return (
    <div className="space-y-6">
      {/* Date range */}
      <div className="flex items-end gap-4">
        <label className="text-sm">
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="ml-2 rounded border px-2 py-1 text-sm" />
        </label>
        <label className="text-sm">
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="ml-2 rounded border px-2 py-1 text-sm" />
        </label>
        <button onClick={load} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <SummaryCard label="Total" value={s.total} />
        <SummaryCard label="Completed" value={s.completed} color="text-green-600" />
        <SummaryCard label="Pending" value={s.pending} color="text-yellow-600" />
        <SummaryCard label="Urgent Pending" value={s.urgent_pending} color="text-red-600" />
        <SummaryCard label="Avg TAT (hrs)" value={s.avg_tat_hours ? Number(s.avg_tat_hours).toFixed(1) : "—"} />
      </div>

      {/* Urgent pending table */}
      {dashboard.urgent_pending.length > 0 && (
        <section>
          <h3 className="mb-2 text-lg font-semibold text-red-700">⚠️ Urgent Pending</h3>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">Test</th>
                  <th className="px-3 py-2">Doctor</th>
                  <th className="px-3 py-2">Waiting (hrs)</th>
                  <th className="px-3 py-2">Priority</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.urgent_pending.map((inv) => (
                  <tr key={inv.id}
                    className={Number(inv.hours_waiting) > 2 ? "bg-red-50" : ""}>
                    <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                    <td className="px-3 py-2">{inv.test_name}</td>
                    <td className="px-3 py-2">{inv.doctor_name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{inv.hours_waiting ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Chip label={inv.priority} className={priorityColor(inv.priority)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent completed */}
      {dashboard.recent_completed.length > 0 && (
        <section>
          <h3 className="mb-2 text-lg font-semibold">Recent Completed</h3>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">Test</th>
                  <th className="px-3 py-2">TAT (hrs)</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.recent_completed.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                    <td className="px-3 py-2">{inv.test_name}</td>
                    <td className="px-3 py-2 font-mono">{inv.tat_hours ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Chip label={inv.status} className={statusColor(inv.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${color ?? ""}`}>{value}</p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 * ALL INVESTIGATIONS TAB
 * ════════════════════════════════════════════════════════════ */

function AllInvestigationsTab() {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ status: "", priority: "", from: "", to: "" });
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit };
      if (filters.status) params.status = filters.status;
      if (filters.priority) params.priority = filters.priority;
      if (filters.from) params.from_date = filters.from;
      if (filters.to) params.to_date = filters.to;

      const res = await getInvestigationsList(params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = res as any;
      const d = raw?.data ?? raw;
      setInvestigations((d?.investigations as Investigation[]) ?? []);
      const pag = d?.pagination;
      setTotal(Number(pag?.total ?? 0));
    } catch {
      toast.error("Failed to load investigations");
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / limit);

  async function handleStatusUpdate(id: number, newStatus: string) {
    try {
      await updateInvestigationStatus(id, newStatus);
      toast.success("Status updated");
      load();
    } catch {
      toast.error("Failed to update status");
    }
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          className="rounded border px-2 py-1 text-sm">
          <option value="">All Status</option>
          {["PENDING", "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
          className="rounded border px-2 py-1 text-sm">
          <option value="">All Priority</option>
          {["URGENT", "HIGH", "NORMAL", "LOW"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          className="rounded border px-2 py-1 text-sm" placeholder="From" />
        <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          className="rounded border px-2 py-1 text-sm" placeholder="To" />
        <button onClick={() => { setPage(1); load(); }}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
          Filter
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Loading…</div>
      ) : investigations.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">No investigations found</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Test</th>
                  <th className="px-3 py-2">Priority</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Ordered</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {investigations.map((inv) => {
                  const isUrgent = ["URGENT", "STAT"].includes(inv.priority?.toUpperCase());
                  return (
                    <tr key={inv.id} className={isUrgent ? "bg-red-50/60" : ""}>
                      <td className="px-3 py-2 font-mono text-xs">{inv.id}</td>
                      <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{inv.phone ?? "—"}</td>
                      <td className="px-3 py-2">{inv.test_name}</td>
                      <td className="px-3 py-2">
                        <Chip label={inv.priority ?? "—"} className={priorityColor(inv.priority)} />
                      </td>
                      <td className="px-3 py-2">
                        <Chip label={inv.status ?? "—"} className={statusColor(inv.status)} />
                      </td>
                      <td className="px-3 py-2 text-xs">{formatDate(inv.ordered_date)}</td>
                      <td className="px-3 py-2">
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) handleStatusUpdate(inv.id, e.target.value);
                            e.target.value = "";
                          }}
                          className="rounded border px-1 py-0.5 text-xs"
                        >
                          <option value="" disabled>Update…</option>
                          {["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"].map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                className="rounded border px-3 py-1 text-sm disabled:opacity-40">Prev</button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages} ({total} total)
              </span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
                className="rounded border px-3 py-1 text-sm disabled:opacity-40">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 * TEST CATALOG TAB
 * ════════════════════════════════════════════════════════════ */

function TestCatalogTab() {
  const [catalog, setCatalog] = useState<TestCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<Partial<TestCatalogItem> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTestCatalog();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = res as any;
      const data = raw?.data ?? raw;
      setCatalog(Array.isArray(data) ? (data as TestCatalogItem[]) : []);
    } catch {
      toast.error("Failed to load test catalog");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(item: Partial<TestCatalogItem>) {
    try {
      await upsertTestCatalog(item);
      toast.success(item.id ? "Test updated" : "Test added");
      setShowForm(false);
      setEditItem(null);
      load();
    } catch {
      toast.error("Failed to save");
    }
  }

  // Group by category
  const grouped = catalog.reduce<Record<string, TestCatalogItem[]>>((acc, item) => {
    const cat = item.category || "other";
    (acc[cat] = acc[cat] || []).push(item);
    return acc;
  }, {});

  const categoryLabels: Record<string, string> = {
    blood: "🩸 Blood",
    urine: "🧪 Urine",
    radiology: "📷 Radiology",
    microbiology: "🦠 Microbiology",
    cardiac: "❤️ Cardiac",
    pathology: "🔬 Pathology",
  };

  if (loading) return <div className="py-12 text-center text-muted-foreground">Loading catalog…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Test Catalog ({catalog.length} tests)</h3>
        <button
          onClick={() => { setEditItem({}); setShowForm(true); }}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
        >
          + Add Test
        </button>
      </div>

      {/* Modal form */}
      {showForm && (
        <CatalogForm
          initial={editItem ?? {}}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditItem(null); }}
        />
      )}

      {/* Grouped display */}
      {Object.entries(grouped).map(([cat, items]) => (
        <section key={cat}>
          <h4 className="mb-2 text-base font-semibold capitalize">
            {categoryLabels[cat] ?? cat}
          </h4>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Cost (₹)</th>
                  <th className="px-3 py-2">TAT (hrs)</th>
                  <th className="px-3 py-2">Fasting</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2">{item.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{item.code ?? "—"}</td>
                    <td className="px-3 py-2">{item.default_cost != null ? `₹${item.default_cost}` : "—"}</td>
                    <td className="px-3 py-2">{item.turnaround_hours}h</td>
                    <td className="px-3 py-2">
                      {item.requires_fasting && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">Fasting</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => { setEditItem(item); setShowForm(true); }}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function CatalogForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Partial<TestCatalogItem>;
  onSave: (item: Partial<TestCatalogItem>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Partial<TestCatalogItem>>({
    name: "",
    code: "",
    category: "blood",
    default_cost: undefined,
    turnaround_hours: 24,
    requires_fasting: false,
    normal_range: "",
    unit: "",
    patient_instructions: "",
    description: "",
    ...initial,
  });

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h4 className="mb-3 font-semibold">{initial.id ? "Edit Test" : "Add New Test"}</h4>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <input placeholder="Test Name *" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm" />
        <input placeholder="Code" value={form.code ?? ""} onChange={(e) => set("code", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm" />
        <select value={form.category ?? "blood"} onChange={(e) => set("category", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm">
          {["blood", "urine", "radiology", "microbiology", "cardiac", "pathology"].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input type="number" placeholder="Cost (₹)" value={form.default_cost ?? ""} onChange={(e) => set("default_cost", e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border px-3 py-1.5 text-sm" />
        <input type="number" placeholder="TAT (hours)" value={form.turnaround_hours ?? 24} onChange={(e) => set("turnaround_hours", Number(e.target.value))}
          className="rounded border px-3 py-1.5 text-sm" />
        <input placeholder="Normal Range" value={form.normal_range ?? ""} onChange={(e) => set("normal_range", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm" />
        <input placeholder="Unit" value={form.unit ?? ""} onChange={(e) => set("unit", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.requires_fasting ?? false} onChange={(e) => set("requires_fasting", e.target.checked)} />
          Requires Fasting
        </label>
        <input placeholder="Patient Instructions" value={form.patient_instructions ?? ""} onChange={(e) => set("patient_instructions", e.target.value)}
          className="col-span-full rounded border px-3 py-1.5 text-sm" />
        <input placeholder="Description" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)}
          className="col-span-full rounded border px-3 py-1.5 text-sm" />
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={() => onSave(form)} className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground">
          {initial.id ? "Update" : "Add"}
        </button>
        <button onClick={onCancel} className="rounded border px-4 py-1.5 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 * NOTIFICATIONS TAB
 * ════════════════════════════════════════════════════════════ */

function NotificationsTab() {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { status: "COMPLETED", notified: "false", limit: 50, page: 1 };
      const res = await getInvestigationsList(params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = res as any;
      const d = raw?.data ?? raw;
      const all = (d?.investigations as Investigation[]) ?? [];
      // Filter client-side to only show un-notified completed
      setInvestigations(all.filter((inv) => !inv.notified));
    } catch {
      toast.error("Failed to load un-notified investigations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function hoursSince(dateStr: string | null) {
    if (!dateStr) return "—";
    const diff = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
    return diff.toFixed(1);
  }

  if (loading) return <div className="py-12 text-center text-muted-foreground">Loading…</div>;
  if (investigations.length === 0) {
    return <div className="py-12 text-center text-muted-foreground">All completed investigations have been notified ✅</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {investigations.length} completed investigation(s) pending patient notification
      </p>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left">
            <tr>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Test</th>
              <th className="px-3 py-2">Completed</th>
              <th className="px-3 py-2">Hours Since</th>
            </tr>
          </thead>
          <tbody>
            {investigations.map((inv) => (
              <tr key={inv.id}>
                <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{inv.phone ?? "—"}</td>
                <td className="px-3 py-2">{inv.test_name}</td>
                <td className="px-3 py-2 text-xs">{formatDate(inv.completed_date)}</td>
                <td className="px-3 py-2 font-mono">{hoursSince(inv.completed_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 * LAB BOOKINGS TAB
 * ════════════════════════════════════════════════════════════ */

function LabBookingsTab() {
  const [sla, setSla] = useState<BookingSLADashboard | null>(null);
  const [bookings, setBookings] = useState<InvestigationBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.collection_type = typeFilter;
      const [slaData, queueData] = await Promise.all([
        getBookingSLA().catch(() => null),
        getBookingQueue(params),
      ]);
      setSla(slaData);
      setBookings(Array.isArray(queueData) ? queueData : []);
    } catch {
      toast.error("Failed to load lab bookings");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleConfirm = async (id: number) => {
    const notes = prompt("Confirmation notes (optional):");
    if (notes === null) return;
    setActionLoading(id);
    try {
      await confirmBooking(id, { confirmation_notes: notes || undefined });
      toast.success("Booking confirmed");
      await fetchData();
    } catch {
      toast.error("Failed to confirm");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDispatch = async (id: number) => {
    const phone = prompt("Collector phone (optional):");
    if (phone === null) return;
    setActionLoading(id);
    try {
      await dispatchCollectorBooking(id, { collector_phone: phone || undefined });
      toast.success("Collector dispatched");
      await fetchData();
    } catch {
      toast.error("Failed to dispatch");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCollected = async (id: number) => {
    setActionLoading(id);
    try {
      await markBookingCollected(id);
      toast.success("Samples collected");
      await fetchData();
    } catch {
      toast.error("Failed to update");
    } finally {
      setActionLoading(null);
    }
  };

  const handleProcessing = async (id: number) => {
    setActionLoading(id);
    try {
      await startBookingProcessing(id);
      toast.success("Processing started");
      await fetchData();
    } catch {
      toast.error("Failed to update");
    } finally {
      setActionLoading(null);
    }
  };

  const handleUploadResult = async (id: number) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.jpg,.png,.doc,.docx";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const notes = prompt("Result notes (optional):") ?? undefined;
      setActionLoading(id);
      try {
        await uploadBookingResult(id, file, notes);
        toast.success("Result uploaded");
        await fetchData();
      } catch {
        toast.error("Upload failed");
      } finally {
        setActionLoading(null);
      }
    };
    input.click();
  };

  const renderActions = (b: InvestigationBooking) => {
    const isLoading = actionLoading === b.id;
    if (isLoading) return <span className="text-xs text-muted-foreground">Processing...</span>;

    switch (b.status) {
      case "BOOKED":
        return (
          <button onClick={() => handleConfirm(b.id)} className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">
            Confirm
          </button>
        );
      case "CONFIRMED":
        return (
          <button onClick={() => handleDispatch(b.id)} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700">
            Dispatch
          </button>
        );
      case "DISPATCHED":
        return (
          <button onClick={() => handleCollected(b.id)} className="px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700">
            Mark Collected
          </button>
        );
      case "COLLECTED":
        return (
          <button onClick={() => handleProcessing(b.id)} className="px-2 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700">
            Start Processing
          </button>
        );
      case "PROCESSING":
        return (
          <button onClick={() => handleUploadResult(b.id)} className="px-2 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700">
            Upload Result
          </button>
        );
      case "RESULT_READY":
        return b.result_file_url ? (
          <a href={b.result_file_url} target="_blank" rel="noopener noreferrer" className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">
            View Result
          </a>
        ) : <span className="text-xs text-muted-foreground">Done</span>;
      default:
        return null;
    }
  };

  const statuses = ["BOOKED", "CONFIRMED", "DISPATCHED", "COLLECTED", "PROCESSING", "RESULT_READY"];

  if (loading) return <p className="text-center py-8 text-muted-foreground">Loading...</p>;

  return (
    <div className="space-y-6">
      {/* SLA Overview */}
      {sla && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">SLA Overview</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SlaCard label="Total Bookings" value={sla.summary.total} />
            <SlaCard label="Pending Confirm" value={sla.summary.booked} color={Number(sla.summary.booked) > 0 ? "text-orange-600" : undefined} />
            <SlaCard label="In Progress" value={String(Number(sla.summary.confirmed || 0) + Number(sla.summary.dispatched || 0) + Number(sla.summary.collected || 0) + Number(sla.summary.processing || 0))} />
            <SlaCard label="Results Ready" value={sla.summary.result_ready} color="text-green-600" />
            <SlaCard label="SLA Breaches" value={String(sla.sla_breaches)} color={sla.sla_breaches > 0 ? "text-red-600" : undefined} />
            <SlaCard label="Revenue" value={`₹${Number(sla.summary.total_revenue || 0).toLocaleString()}`} />
          </div>
          {/* Average Times */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SlaCard label="Avg Confirm" value={sla.avg_times.avg_confirm_mins ? `${Number(sla.avg_times.avg_confirm_mins).toFixed(0)} min` : "—"} />
            <SlaCard label="Avg Dispatch" value={sla.avg_times.avg_dispatch_mins ? `${Number(sla.avg_times.avg_dispatch_mins).toFixed(0)} min` : "—"} />
            <SlaCard label="Avg Collect" value={sla.avg_times.avg_collect_mins ? `${Number(sla.avg_times.avg_collect_mins).toFixed(0)} min` : "—"} />
            <SlaCard label="Avg Result" value={sla.avg_times.avg_result_hours ? `${Number(sla.avg_times.avg_result_hours).toFixed(1)} hrs` : "—"} />
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="">All Statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="">All Types</option>
          <option value="home">Home Collection</option>
          <option value="walk_in">Walk-in</option>
        </select>
        <button
          onClick={() => void fetchData()}
          className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:opacity-90"
        >
          Refresh
        </button>
      </div>

      {/* Active Bookings Table */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2">Booking #</th>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Tests</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">ETA</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {bookings.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">No bookings found</td></tr>
            ) : (
              bookings.map((b) => {
                const isBreach = b.sla_breached;
                const testDisplay = b.test_names?.join(", ") || b.custom_test_names || (b.slip_photo_key ? "📋 Slip" : "—");
                const mins = b.mins_since_booked ?? 0;
                const timeStr = mins > 60 ? `${(mins / 60).toFixed(1)}h` : `${Math.round(mins)}m`;
                return (
                  <tr key={b.id} className={`border-b ${isBreach ? "bg-red-50" : "hover:bg-muted/30"}`}>
                    <td className="px-3 py-2 font-mono text-xs">{b.booking_number}</td>
                    <td className="px-3 py-2">{b.patient_name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{b.patient_phone ?? "—"}</td>
                    <td className="px-3 py-2 text-xs max-w-[200px] truncate" title={testDisplay}>{testDisplay}</td>
                    <td className="px-3 py-2">
                      <Chip
                        label={b.collection_type === "home" ? "🏠 Home" : "🏥 Walk-in"}
                        className={b.collection_type === "home" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Chip
                        label={b.status.replace("_", " ")}
                        className={statusColor(b.status)}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {b.status === "DISPATCHED" && b.estimated_collection_mins ? (
                        <span className="flex items-center gap-1">
                          {b.collection_tracking_active && <span title="Live tracking">📍</span>}
                          ~{b.estimated_collection_mins}m
                          {b.collection_distance_km ? <span className="text-muted-foreground ml-1">({b.collection_distance_km}km)</span> : null}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {timeStr}
                      {isBreach && <span className="ml-1 text-red-600" title="SLA Breached">⚠️</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      ₹{b.final_cost ?? b.estimated_cost ?? "—"}
                    </td>
                    <td className="px-3 py-2">{renderActions(b)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SlaCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold ${color ?? ""}`}>{value}</p>
    </div>
  );
}
