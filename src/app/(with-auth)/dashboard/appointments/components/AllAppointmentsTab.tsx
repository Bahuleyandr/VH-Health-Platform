"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "react-hot-toast";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cancelAppointmentAdmin,
  completeAppointmentAdmin,
  confirmAppointmentAdmin,
  markNoShowAdmin,
  type AppointmentWorkflow,
} from "@/lib/api/appointments";
import { PaginationControls } from "../../users/components/PaginationControls";
import { AppointmentFilters } from "./AppointmentFilters";
import { AppointmentsTable } from "./AppointmentsTable";
import {
  fmtDate,
  normalizeAppointmentsResponse,
  StatusBadge,
  type AppointmentRow,
  type AppointmentsAPIResponse,
} from "./helpers";

export function AllAppointmentsTab() {
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
