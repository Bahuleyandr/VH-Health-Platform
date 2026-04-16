"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  confirmAppointmentAdmin,
  getAppointmentSlaDashboard,
  type AppointmentWorkflow,
  type SlaDashboardResponse,
} from "@/lib/api/appointments";
import { fmtDate } from "./helpers";

export function SlaOverviewTab() {
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
