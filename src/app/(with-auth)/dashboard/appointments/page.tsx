// src/app/(with-auth)/dashboard/appointments/page.tsx
"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchAdminAPI } from "@/lib/api";
import type { Appointment } from "@/lib/types";
import { AppointmentsTable } from "./components/AppointmentsTable";
import { PaginationControls } from "../users/components/PaginationControls";
import { AppointmentFilters } from "./components/AppointmentFilters";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAppointmentSlaDashboard,
  confirmAppointmentAdmin,
  markNoShowAdmin,
  completeAppointmentAdmin,
  cancelAppointmentAdmin,
  getAllAppointmentDocuments,
  getAppointmentAuditTrail,
  getAvailableSlots,
  registerWalkInAdmin,
  getTodayQueueAdmin,
  type AppointmentWorkflow,
  type SlaDashboardResponse,
  type AppointmentDocument,
  type AuditEntry,
  type SlotInfo,
} from "@/lib/api/appointments";
import { toast } from "react-hot-toast";

// ── Types ─────────────────────────────────────────────────────────────────────

type AppointmentRow = Appointment & {
  patient_name?: string;
  doctor_name?: string;
  department?: string;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

type AppointmentsAPIResponse = {
  appointments: AppointmentRow[];
  pagination: Pagination;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function normalizeAppointmentsResponse(response: unknown, page: number): AppointmentsAPIResponse {
  if (Array.isArray(response)) {
    const list = response as AppointmentRow[];
    return { appointments: list, pagination: { page, limit: 10, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / 10)), hasNext: false, hasPrev: page > 1 } };
  }
  if (isObj(response)) {
    const appts = (Array.isArray((response as Record<string, unknown>)["appointments"]) ? (response as Record<string, unknown>)["appointments"] : (response as Record<string, unknown>)["data"]) as AppointmentRow[] ?? [];
    const total = typeof (response as Record<string, unknown>)["total"] === "number" ? (response as Record<string, unknown>)["total"] as number : appts.length;
    const limit = 10;
    return { appointments: appts, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasNext: page * limit < total, hasPrev: page > 1 } };
  }
  return { appointments: [], pagination: { page, limit: 10, total: 0, totalPages: 1, hasNext: false, hasPrev: page > 1 } };
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    SCHEDULED: "bg-orange-100 text-orange-700",
    CONFIRMED: "bg-teal-100 text-teal-700",
    COMPLETED: "bg-green-100 text-green-700",
    CANCELLED: "bg-red-100 text-red-700",
    NO_SHOW: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${map[status] ?? "bg-blue-100 text-blue-700"}`}>
      {status}
    </span>
  );
}

// ── SLA Overview Tab ─────────────────────────────────────────────────────────

function SlaOverviewTab() {
  const [data, setData] = useState<SlaDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      const res = await getAppointmentSlaDashboard(params);
      setData(res as SlaDashboardResponse);
    } catch {
      toast.error("Failed to load SLA dashboard");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const handleConfirm = async (appt: AppointmentWorkflow) => {
    setConfirming(appt.id);
    try {
      await confirmAppointmentAdmin(appt.id, {});
      toast.success(`Appointment #${appt.id} confirmed`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to confirm");
    } finally {
      setConfirming(null);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div>;
  if (!data) return null;

  const { summary, sla, by_department, pending_confirmation } = data;
  const slaTotal = parseInt(sla.total_with_sla) || 0;
  const slaWithin = parseInt(sla.within_sla) || 0;
  const slaPct = slaTotal > 0 ? Math.round((slaWithin / slaTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Date filter */}
      <div className="flex gap-3 items-center">
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm" placeholder="From" />
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm" placeholder="To" />
        <button onClick={load} className="bg-primary text-white text-sm px-4 py-1.5 rounded">Apply</button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Total", value: summary.total, color: "bg-blue-50 text-blue-700" },
          { label: "Confirmed", value: summary.confirmed, color: "bg-teal-50 text-teal-700" },
          { label: "Completed", value: summary.completed, color: "bg-green-50 text-green-700" },
          { label: "Cancelled", value: summary.cancelled, color: "bg-red-50 text-red-700" },
          { label: "No-Show", value: summary.no_show, color: "bg-gray-50 text-gray-700" },
          { label: "Pending Confirm", value: summary.pending_confirmation, color: "bg-orange-50 text-orange-700" },
        ].map(c => (
          <div key={c.label} className={`rounded-lg p-4 ${c.color}`}>
            <div className="text-2xl font-bold">{c.value}</div>
            <div className="text-xs mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      {/* SLA card */}
      <div className="border rounded-lg p-4">
        <h3 className="font-semibold mb-3">Confirmation SLA (last 7 days)</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div><div className={`text-2xl font-bold ${slaPct >= 80 ? 'text-green-600' : slaPct >= 60 ? 'text-orange-600' : 'text-red-600'}`}>{slaPct}%</div><div className="text-xs text-gray-500">Within SLA</div></div>
          <div><div className="text-2xl font-bold text-blue-600">{sla.avg_response_minutes ? parseFloat(sla.avg_response_minutes).toFixed(0) : "—"} min</div><div className="text-xs text-gray-500">Avg Response</div></div>
          <div><div className="text-2xl font-bold text-green-600">{sla.within_sla}</div><div className="text-xs text-gray-500">Within SLA</div></div>
          <div><div className="text-2xl font-bold text-red-600">{sla.breached_sla}</div><div className="text-xs text-gray-500">SLA Breaches</div></div>
        </div>
      </div>

      {/* By department */}
      {by_department.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-muted/50 px-4 py-2 text-sm font-semibold">By Department</div>
          <table className="w-full text-sm">
            <thead><tr className="border-b"><th className="px-4 py-2 text-left">Department</th><th className="px-4 py-2 text-right">Total</th><th className="px-4 py-2 text-right">Confirmed</th><th className="px-4 py-2 text-right">Completed</th><th className="px-4 py-2 text-right">Cancelled</th></tr></thead>
            <tbody>
              {by_department.map((d, i) => (
                <tr key={i} className="border-b hover:bg-muted/20">
                  <td className="px-4 py-2 font-medium">{d.department}</td>
                  <td className="px-4 py-2 text-right">{d.total}</td>
                  <td className="px-4 py-2 text-right text-teal-600">{d.confirmed}</td>
                  <td className="px-4 py-2 text-right text-green-600">{d.completed}</td>
                  <td className="px-4 py-2 text-right text-red-600">{d.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pending confirmation */}
      {pending_confirmation.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700">
            Pending Confirmation ({pending_confirmation.length})
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50"><th className="px-4 py-2 text-left">Patient</th><th className="px-4 py-2 text-left">Phone</th><th className="px-4 py-2 text-left">Doctor</th><th className="px-4 py-2 text-left">Date/Time</th><th className="px-4 py-2 text-left">Waiting</th><th className="px-4 py-2 text-left">Action</th></tr></thead>
            <tbody>
              {pending_confirmation.map((appt) => (
                <tr key={appt.id} className={`border-b hover:bg-muted/20 ${appt.sla_breached ? 'bg-red-50' : ''}`}>
                  <td className="px-4 py-2 font-medium">{appt.patient_name ?? "—"}</td>
                  <td className="px-4 py-2">{appt.patient_phone ?? "—"}</td>
                  <td className="px-4 py-2">{appt.doctor_name ?? "—"}</td>
                  <td className="px-4 py-2">{fmtDate(appt.appointment_date)} {appt.appointment_time}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs font-medium ${appt.sla_breached ? 'text-red-600' : 'text-gray-600'}`}>
                      {appt.mins_waiting != null ? `${Math.round(appt.mins_waiting)} min` : "—"}
                      {appt.sla_breached && " ⚠️"}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      disabled={confirming === appt.id}
                      onClick={() => handleConfirm(appt)}
                      className="text-xs bg-teal-600 text-white px-3 py-1 rounded hover:bg-teal-700 disabled:opacity-50"
                    >
                      {confirming === appt.id ? "Confirming…" : "Confirm"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── All Appointments Tab ──────────────────────────────────────────────────────

function AllAppointmentsTab() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [data, setData] = useState<AppointmentsAPIResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<{ id: number; action: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setLoading(true);
      try {
        const page = parseInt(searchParams.get("page") || "1");
        const status = searchParams.get("status");
        const search = searchParams.get("search");
        const params = new URLSearchParams();
        params.set("page", String(page));
        if (status) params.set("status", status);
        if (search) params.set("search", search);
        const res = await fetchAdminAPI<unknown>(`/appointments/list?${params}`);
        if (!cancelled) setData(normalizeAppointmentsResponse(res, page));
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    return () => { cancelled = true; };
  }, [searchParams]);

  const doAction = async (id: number, action: string, extra?: Record<string, string>) => {
    setActing({ id, action });
    try {
      if (action === "confirm") await confirmAppointmentAdmin(id, {});
      else if (action === "complete") await completeAppointmentAdmin(id, {});
      else if (action === "no-show") await markNoShowAdmin(id);
      else if (action === "cancel") await cancelAppointmentAdmin(id, { cancellation_reason: extra?.reason });
      toast.success(`Done: ${action}`);
      // Refresh
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setActing(null);
    }
  };

  if (loading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-4">
      <AppointmentFilters />
      {data && <AppointmentsTable appointments={data.appointments} />}
      {data && data.appointments.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50"><th className="px-3 py-2 text-left">Patient</th><th className="px-3 py-2 text-left">Phone</th><th className="px-3 py-2 text-left">Doctor</th><th className="px-3 py-2 text-left">Dept</th><th className="px-3 py-2 text-left">Date/Time</th><th className="px-3 py-2 text-left">Token</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Reminders</th><th className="px-3 py-2 text-left">Actions</th></tr></thead>
            <tbody>
              {data.appointments.map((appt) => {
                const a = appt as AppointmentRow & AppointmentWorkflow;
                const isActing = acting?.id === a.id;
                return (
                  <tr key={a.id} className="border-b hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">{a.patient_name ?? "—"}</td>
                    <td className="px-3 py-2">{a.phone ?? "—"}</td>
                    <td className="px-3 py-2">{a.doctor_name ?? "—"}</td>
                    <td className="px-3 py-2">{(a as AppointmentWorkflow).department ?? "—"}</td>
                    <td className="px-3 py-2">{fmtDate(a.appointment_date)} {a.appointment_time}</td>
                    <td className="px-3 py-2">{(a as AppointmentWorkflow).token_number ?? "—"}</td>
                    <td className="px-3 py-2"><StatusBadge status={a.status?.toUpperCase()} /></td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${(a as unknown as Record<string, unknown>).reminder_24h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`} title="24h reminder">24h</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${(a as unknown as Record<string, unknown>).reminder_1h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`} title="1h reminder">1h</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {a.status?.toUpperCase() === "SCHEDULED" && (
                          <button disabled={isActing} onClick={() => doAction(a.id, "confirm")}
                            className="text-xs bg-teal-600 text-white px-2 py-0.5 rounded hover:bg-teal-700 disabled:opacity-50">
                            Confirm
                          </button>
                        )}
                        {a.status?.toUpperCase() === "CONFIRMED" && (
                          <button disabled={isActing} onClick={() => doAction(a.id, "complete")}
                            className="text-xs bg-green-600 text-white px-2 py-0.5 rounded hover:bg-green-700 disabled:opacity-50">
                            Complete
                          </button>
                        )}
                        {!["COMPLETED", "CANCELLED", "NO_SHOW"].includes(a.status?.toUpperCase()) && (
                          <button disabled={isActing} onClick={() => doAction(a.id, "no-show")}
                            className="text-xs bg-gray-500 text-white px-2 py-0.5 rounded hover:bg-gray-600 disabled:opacity-50">
                            No-Show
                          </button>
                        )}
                        {!["COMPLETED", "CANCELLED"].includes(a.status?.toUpperCase()) && (
                          <button disabled={isActing} onClick={() => {
                            const r = prompt("Cancellation reason?");
                            if (r !== null) doAction(a.id, "cancel", { reason: r });
                          }}
                            className="text-xs bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600 disabled:opacity-50">
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && <PaginationControls pagination={data.pagination} />}
    </div>
  );
}

// ── Documents Tab ─────────────────────────────────────────────────────────────

function DocumentsTab() {
  const [docs, setDocs] = useState<AppointmentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      const res = await getAllAppointmentDocuments(params);
      setDocs(Array.isArray(res) ? res : []);
    } catch {
      toast.error("Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center">
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <button onClick={load} className="bg-primary text-white text-sm px-4 py-1.5 rounded">Filter</button>
      </div>

      {loading ? <Skeleton className="h-48 w-full" /> : docs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No documents found</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50"><th className="px-4 py-2 text-left">Patient</th><th className="px-4 py-2 text-left">Doctor</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">File</th><th className="px-4 py-2 text-left">Uploaded By</th><th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-left">Download</th></tr></thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="border-b hover:bg-muted/20">
                  <td className="px-4 py-2">{doc.patient_name ?? `Patient #${doc.patient_id}`}</td>
                  <td className="px-4 py-2">{doc.doctor_name ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                      {doc.document_type?.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-2 max-w-xs truncate">{doc.file_name ?? "—"}</td>
                  <td className="px-4 py-2">{doc.uploaded_by_name ?? "—"} <span className="text-xs text-gray-400">({doc.upload_role})</span></td>
                  <td className="px-4 py-2">{fmtDate(doc.created_at)}</td>
                  <td className="px-4 py-2">
                    {doc.file_url ? (
                      <a href={doc.file_url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline">Download</a>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Prescriptions Tab ─────────────────────────────────────────────────────────

interface EPrescription {
  id: number;
  prescription_number: string;
  appointment_id: number | null;
  patient_id: number;
  doctor_id: number;
  diagnosis: string;
  medications: Array<{
    name: string;
    generic_name?: string;
    catalog_id?: number;
    dosage: string;
    frequency: string;
    duration: string;
    route: string;
    instructions?: string;
    quantity?: number;
  }>;
  vitals?: Record<string, number>;
  follow_up_date?: string;
  follow_up_notes?: string;
  clinical_notes?: string;
  pdf_key?: string;
  pdf_url?: string;
  pharmacy_opted: boolean;
  pharmacy_order_id?: number;
  pharmacy_opt_type?: string;
  status: string;
  created_at: string;
  patient_name?: string;
  patient_phone?: string;
  doctor_name?: string;
  doctor_specialization?: string;
}

function PrescriptionsTab() {
  const [prescriptions, setPrescriptions] = useState<EPrescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<EPrescription | null>(null);
  const [filterDoctor, setFilterDoctor] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const fetchPrescriptions = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterDoctor) params.doctor_id = filterDoctor;
      if (filterFrom) params.from_date = filterFrom;
      if (filterTo) params.to_date = filterTo;
      const qs = new URLSearchParams(params).toString();
      const res = await fetchAdminAPI(`/prescriptions/all${qs ? `?${qs}` : ""}`);
      const raw = Array.isArray(res) ? res : (isObj(res) ? ((res as Record<string,unknown>).prescriptions ?? (res as Record<string,unknown>).data ?? res) : []);
      const data = Array.isArray(raw) ? (raw as EPrescription[]) : [];
      setPrescriptions(data);
    } catch (e) {
      toast.error("Failed to load prescriptions");
    } finally {
      setLoading(false);
    }
  }, [filterDoctor, filterFrom, filterTo]);

  useEffect(() => { fetchPrescriptions(); }, [fetchPrescriptions]);

  const freqLabel: Record<string, string> = {
    OD: "Once daily", BD: "Twice daily", TDS: "Thrice daily",
    QID: "Four times", SOS: "As needed", HS: "At bedtime", STAT: "Immediately",
  };

  if (selected) {
    const rx = selected;
    return (
      <div>
        <button onClick={() => setSelected(null)} className="text-sm text-teal-600 mb-4 hover:underline">← Back to list</button>
        <div className="bg-white rounded-lg border p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="text-xl font-bold">{rx.prescription_number}</h3>
              <p className="text-sm text-gray-500">Patient: {rx.patient_name} • {rx.patient_phone}</p>
              <p className="text-sm text-gray-500">Dr. {rx.doctor_name} • {rx.doctor_specialization}</p>
              <p className="text-sm text-gray-400">{fmtDateTime(rx.created_at)}</p>
            </div>
            <div className="flex gap-2">
              <StatusBadge status={rx.status} />
              {rx.pharmacy_opted && <span className="px-2 py-1 rounded-full text-xs bg-green-100 text-green-700">Pharmacy: {rx.pharmacy_opt_type}</span>}
            </div>
          </div>

          {rx.diagnosis && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">Diagnosis</h4>
              <p className="text-sm">{rx.diagnosis}</p>
            </div>
          )}

          {rx.vitals && Object.keys(rx.vitals).length > 0 && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">Vitals</h4>
              <div className="flex flex-wrap gap-3 text-sm">
                {rx.vitals.bp_systolic && rx.vitals.bp_diastolic && <span>BP: {rx.vitals.bp_systolic}/{rx.vitals.bp_diastolic}</span>}
                {rx.vitals.pulse && <span>Pulse: {rx.vitals.pulse}</span>}
                {rx.vitals.temperature && <span>Temp: {rx.vitals.temperature}°F</span>}
                {rx.vitals.spo2 && <span>SpO2: {rx.vitals.spo2}%</span>}
                {rx.vitals.weight && <span>Weight: {rx.vitals.weight}kg</span>}
                {rx.vitals.blood_sugar && <span>Sugar: {rx.vitals.blood_sugar}</span>}
              </div>
            </div>
          )}

          <div className="mb-4">
            <h4 className="font-semibold text-sm text-gray-700 mb-2">Medications ({rx.medications.length})</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2 border-b">#</th>
                    <th className="text-left p-2 border-b">Medicine</th>
                    <th className="text-left p-2 border-b">Dosage</th>
                    <th className="text-left p-2 border-b">Frequency</th>
                    <th className="text-left p-2 border-b">Duration</th>
                    <th className="text-left p-2 border-b">Route</th>
                    <th className="text-left p-2 border-b">Instructions</th>
                  </tr>
                </thead>
                <tbody>
                  {rx.medications.map((m, i) => (
                    <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                      <td className="p-2 border-b">{i + 1}</td>
                      <td className="p-2 border-b font-medium">{m.name}{m.generic_name ? ` (${m.generic_name})` : ""}</td>
                      <td className="p-2 border-b">{m.dosage || "-"}</td>
                      <td className="p-2 border-b">{freqLabel[m.frequency] || m.frequency || "-"}</td>
                      <td className="p-2 border-b">{m.duration || "-"}</td>
                      <td className="p-2 border-b">{m.route || "Oral"}</td>
                      <td className="p-2 border-b">{m.instructions || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {rx.follow_up_date && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">Follow-up</h4>
              <p className="text-sm">{fmtDate(rx.follow_up_date)}{rx.follow_up_notes ? ` — ${rx.follow_up_notes}` : ""}</p>
            </div>
          )}

          {rx.clinical_notes && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">Clinical Notes</h4>
              <p className="text-sm">{rx.clinical_notes}</p>
            </div>
          )}

          {rx.pdf_url && (
            <a href={rx.pdf_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-teal-600 hover:underline">
              📄 Download PDF
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm" placeholder="From" />
        <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm" placeholder="To" />
        <button onClick={fetchPrescriptions} className="bg-teal-600 text-white px-4 py-1.5 rounded text-sm hover:bg-teal-700">
          Filter
        </button>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : prescriptions.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-2">📋</p>
          <p>No prescriptions found</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-3 border-b">RX #</th>
                <th className="text-left p-3 border-b">Patient</th>
                <th className="text-left p-3 border-b">Doctor</th>
                <th className="text-left p-3 border-b">Date</th>
                <th className="text-left p-3 border-b">Medicines</th>
                <th className="text-left p-3 border-b">Pharmacy</th>
                <th className="text-left p-3 border-b">Status</th>
              </tr>
            </thead>
            <tbody>
              {prescriptions.map((rx) => (
                <tr key={rx.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(rx)}>
                  <td className="p-3 border-b font-mono text-teal-600">{rx.prescription_number}</td>
                  <td className="p-3 border-b">{rx.patient_name}</td>
                  <td className="p-3 border-b">{rx.doctor_name}</td>
                  <td className="p-3 border-b">{fmtDate(rx.created_at)}</td>
                  <td className="p-3 border-b">{rx.medications.length}</td>
                  <td className="p-3 border-b">
                    {rx.pharmacy_opted ? (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">{rx.pharmacy_opt_type || "ordered"}</span>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="p-3 border-b"><StatusBadge status={rx.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Audit Trail Tab ───────────────────────────────────────────────────────────

function AuditTrailTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      const res = await getAppointmentAuditTrail(params);
      setEntries(Array.isArray(res) ? res : []);
    } catch {
      toast.error("Failed to load audit trail");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center">
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <button onClick={load} className="bg-primary text-white text-sm px-4 py-1.5 rounded">Filter</button>
      </div>

      {loading ? <Skeleton className="h-48 w-full" /> : entries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No audit entries found</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50"><th className="px-4 py-2 text-left">Appt ID</th><th className="px-4 py-2 text-left">Patient</th><th className="px-4 py-2 text-left">Status Change</th><th className="px-4 py-2 text-left">Changed By</th><th className="px-4 py-2 text-left">Role</th><th className="px-4 py-2 text-left">Reason</th><th className="px-4 py-2 text-left">Time</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b hover:bg-muted/20">
                  <td className="px-4 py-2 font-mono text-xs">#{e.appointment_id}</td>
                  <td className="px-4 py-2">{e.patient_name ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-1">
                      {e.from_status && <StatusBadge status={e.from_status} />}
                      {e.from_status && <span className="text-gray-400">→</span>}
                      <StatusBadge status={e.to_status} />
                    </span>
                  </td>
                  <td className="px-4 py-2">{e.changed_by_name ?? `User #${e.changed_by}`}</td>
                  <td className="px-4 py-2 capitalize">{e.changed_by_role ?? "—"}</td>
                  <td className="px-4 py-2 max-w-xs truncate text-gray-600">{e.reason ?? "—"}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{fmtDateTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Walk-in Registration Dialog ───────────────────────────────────────────────

function WalkInDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: (token: number) => void }) {
  const [patientPhone, setPatientPhone] = useState("");
  const [patientName, setPatientName] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [department, setDepartment] = useState("");
  const [reason, setReason] = useState("");
  const [time, setTime] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientPhone && !patientName) {
      toast.error("Patient phone or name required");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, string | number | undefined> = {
        patient_phone: patientPhone || undefined,
        patient_name: patientName || undefined,
        department: department || undefined,
        reason: reason || "Walk-in consultation",
        appointment_time: time || "Walk-in",
      };
      if (doctorId) payload.doctor_id = parseInt(doctorId);
      const res = await registerWalkInAdmin(payload);
      const token = (res as Record<string, unknown>)?.data
        ? ((res as Record<string, unknown>).data as Record<string, unknown>)?.token_number
        : (res as Record<string, unknown>)?.token_number;
      onSuccess(Number(token) || 0);
      toast.success(`Walk-in registered! Token #${token}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to register walk-in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold mb-4">Register Walk-in Patient</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-sm font-medium">Patient Phone</label>
            <input type="tel" value={patientPhone} onChange={e => setPatientPhone(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="10-digit mobile number" />
          </div>
          <div>
            <label className="text-sm font-medium">Patient Name</label>
            <input type="text" value={patientName} onChange={e => setPatientName(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="Full name" />
          </div>
          <div>
            <label className="text-sm font-medium">Doctor ID (optional)</label>
            <input type="number" value={doctorId} onChange={e => setDoctorId(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="Doctor user ID" />
          </div>
          <div>
            <label className="text-sm font-medium">Department</label>
            <input type="text" value={department} onChange={e => setDepartment(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="e.g. General Medicine" />
          </div>
          <div>
            <label className="text-sm font-medium">Appointment Time (optional)</label>
            <input type="time" value={time} onChange={e => setTime(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium">Reason</label>
            <input type="text" value={reason} onChange={e => setReason(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="Walk-in consultation" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border rounded px-4 py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={submitting}
              className="flex-1 bg-teal-600 text-white rounded px-4 py-2 text-sm hover:bg-teal-700 disabled:opacity-50">
              {submitting ? "Registering…" : "Register Walk-in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Doctor Queue View Tab ─────────────────────────────────────────────────────

function DoctorQueueTab() {
  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [queue, setQueue] = useState<AppointmentWorkflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [walked, setWalkedIn] = useState(false);

  const load = async () => {
    if (!doctorId) { toast.error("Enter a doctor ID"); return; }
    setLoading(true);
    try {
      const params: Record<string, string> = { doctor_id: doctorId };
      if (date) params.date = date;
      const res = await getTodayQueueAdmin<unknown>(params);
      const rows = Array.isArray(res)
        ? res
        : Array.isArray((res as Record<string, unknown>)?.data)
          ? (res as Record<string, unknown>).data
          : [];
      setQueue(rows as AppointmentWorkflow[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load queue");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-sm font-medium block mb-1">Doctor ID</label>
          <input type="number" value={doctorId} onChange={e => setDoctorId(e.target.value)}
            className="border rounded px-3 py-2 text-sm w-36" placeholder="User ID" />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border rounded px-3 py-2 text-sm" />
        </div>
        <button onClick={load} className="bg-teal-600 text-white px-4 py-2 text-sm rounded hover:bg-teal-700">
          Load Queue
        </button>
      </div>

      {/* Slot availability panel */}
      {doctorId && date && <SlotAvailabilityPanel doctorId={doctorId} date={date} />}

      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : queue.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {doctorId ? "No appointments found for this doctor/date" : "Enter a doctor ID to load their queue"}
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-teal-50 px-4 py-2 text-sm font-semibold text-teal-800">
            Dr. Queue — {date} ({queue.length} appointments)
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left">Token</th>
                <th className="px-4 py-2 text-left">Patient</th>
                <th className="px-4 py-2 text-left">Blood Group</th>
                <th className="px-4 py-2 text-left">Time</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Reason</th>
                <th className="px-4 py-2 text-left">Reminders</th>
              </tr>
            </thead>
            <tbody>
              {queue
                .sort((a, b) => (a.token_number ?? 999) - (b.token_number ?? 999))
                .map((appt) => {
                  const a = appt as AppointmentWorkflow & { patient_name?: string; blood_group?: string; reminder_24h_sent?: boolean; reminder_1h_sent?: boolean };
                  return (
                    <tr key={a.id} className="border-b hover:bg-muted/20">
                      <td className="px-4 py-2 font-bold text-teal-700">
                        {a.token_number ? `#${a.token_number}` : "—"}
                      </td>
                      <td className="px-4 py-2 font-medium">{a.patient_name ?? `Patient #${a.patient_id}`}</td>
                      <td className="px-4 py-2">
                        {a.blood_group
                          ? <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{a.blood_group}</span>
                          : "—"}
                      </td>
                      <td className="px-4 py-2">{a.appointment_time ?? "—"}</td>
                      <td className="px-4 py-2"><StatusBadge status={a.status?.toUpperCase()} /></td>
                      <td className="px-4 py-2 max-w-xs truncate text-gray-600">{a.reason ?? "—"}</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${a.reminder_24h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>24h</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${a.reminder_1h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>1h</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* Re-trigger walk-in from this tab if needed */}
      <p className="text-xs text-gray-500">
        Use the Walk-in button in the Overview tab or All Appointments tab to add new walk-ins.
      </p>
    </div>
  );
}

// ── Slot Availability Panel ───────────────────────────────────────────────────

function SlotAvailabilityPanel({ doctorId, date }: { doctorId: string; date: string }) {
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  useEffect(() => {
    if (!doctorId || !date) return;
    setLoading(true);
    setUnavailableReason(null);
    getAvailableSlots(doctorId, date)
      .then(res => {
        if (res.available === false) {
          setUnavailableReason(res.reason ?? "Unavailable");
          setSlots([]);
        } else {
          setSlots(res.slots ?? []);
        }
      })
      .catch(() => setSlots([]))
      .finally(() => setLoading(false));
  }, [doctorId, date]);

  if (loading) return <Skeleton className="h-16 w-full" />;
  if (unavailableReason) return (
    <div className="bg-yellow-50 border border-yellow-200 rounded px-4 py-3 text-sm text-yellow-800">
      ⚠️ {unavailableReason}
    </div>
  );
  if (!slots.length) return null;

  return (
    <div className="border rounded-lg p-4">
      <div className="text-sm font-medium mb-3 text-gray-700">
        Available Slots ({slots.filter(s => s.available).length}/{slots.length})
      </div>
      <div className="flex flex-wrap gap-2">
        {slots.map(s => (
          <span key={s.time}
            className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
              s.available
                ? "bg-teal-50 border-teal-300 text-teal-700"
                : "bg-gray-100 border-gray-200 text-gray-400 line-through"
            }`}>
            {s.time}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: "overview", label: "Overview & SLA" },
  { id: "appointments", label: "All Appointments" },
  { id: "queue", label: "Doctor Queue" },
  { id: "documents", label: "Documents" },
  { id: "prescriptions", label: "Prescriptions" },
  { id: "audit", label: "Audit Trail" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function AppointmentsPageContent() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [showWalkIn, setShowWalkIn] = useState(false);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Appointment Management</h2>
        <button
          onClick={() => setShowWalkIn(true)}
          className="bg-teal-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-teal-700 flex items-center gap-2"
        >
          <span>➕</span> Register Walk-in
        </button>
      </div>

      {showWalkIn && (
        <WalkInDialog
          onClose={() => setShowWalkIn(false)}
          onSuccess={() => {}}
        />
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <SlaOverviewTab />}
      {activeTab === "appointments" && (
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <AllAppointmentsTab />
        </Suspense>
      )}
      {activeTab === "queue" && <DoctorQueueTab />}
      {activeTab === "documents" && <DocumentsTab />}
      {activeTab === "prescriptions" && <PrescriptionsTab />}
      {activeTab === "audit" && <AuditTrailTab />}
    </div>
  );
}

export default function AppointmentsPage() {
  return (
    <Suspense fallback={<div className="p-6"><Skeleton className="h-96 w-full" /></div>}>
      <AppointmentsPageContent />
    </Suspense>
  );
}
