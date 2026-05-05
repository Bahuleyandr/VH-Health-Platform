"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  compareTableValues,
  SortableTableHeader,
  type SortDirection,
  type SortValue,
} from "@/components/table/client";
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
  const [acting, setActing] = useState<{ id: number; action: string } | null>(
    null,
  );
  const sortBy = (searchParams.get("sortBy") ||
    "appointment_date") as AppointmentSortKey;
  const sortOrder = (
    searchParams.get("sortOrder") === "DESC" ? "desc" : "asc"
  ) as SortDirection;

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setLoading(true);
      try {
        const page = parseInt(searchParams.get("page") || "1");
        const limit = parseInt(searchParams.get("limit") || "10");
        const status = searchParams.get("status");
        const search = searchParams.get("search");
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("limit", String(limit));
        params.set("sortBy", sortBy);
        params.set("sortOrder", sortOrder.toUpperCase());
        if (status) params.set("status", status);
        if (search) params.set("search", search);
        const res = await fetchAdminAPI<unknown>(
          `/appointments/list?${params}`,
        );
        if (!cancelled)
          setData(normalizeAppointmentsResponse(res, page, limit));
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    return () => {
      cancelled = true;
    };
  }, [searchParams, sortBy, sortOrder]);

  const doAction = async (
    id: number,
    action: string,
    extra?: Record<string, string>,
  ) => {
    setActing({ id, action });
    try {
      if (action === "confirm") await confirmAppointmentAdmin(id, {});
      else if (action === "complete") await completeAppointmentAdmin(id, {});
      else if (action === "no-show") await markNoShowAdmin(id);
      else if (action === "cancel")
        await cancelAppointmentAdmin(id, {
          cancellation_reason: extra?.reason,
        });
      toast.success(`Done: ${action}`);
      // Refresh
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setActing(null);
    }
  };

  const setSort = (key: AppointmentSortKey) => {
    const params = new URLSearchParams(searchParams);
    const nextOrder = sortBy === key && sortOrder === "asc" ? "DESC" : "ASC";
    params.set("sortBy", key);
    params.set("sortOrder", nextOrder);
    router.push(`/dashboard/appointments?${params.toString()}`);
  };

  const rows = useMemo(() => {
    const list = [...(data?.appointments ?? [])];
    list.sort((a, b) => {
      const result = compareTableValues(
        getAppointmentSortValue(a, sortBy),
        getAppointmentSortValue(b, sortBy),
      );
      return sortOrder === "asc" ? result : -result;
    });
    return list;
  }, [data?.appointments, sortBy, sortOrder]);

  if (loading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-4">
      <AppointmentFilters />
      {data && data.appointments.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <SortableTableHeader
                  label="Patient"
                  sortKey="patient"
                  activeSort={sortBy}
                  direction={sortOrder}
                  onSort={setSort}
                  className="!px-3 !py-2"
                />
                <SortableTableHeader
                  label="Phone"
                  sortKey="phone"
                  activeSort={sortBy}
                  direction={sortOrder}
                  onSort={setSort}
                  className="!px-3 !py-2"
                />
                <SortableTableHeader
                  label="Doctor"
                  sortKey="doctor"
                  activeSort={sortBy}
                  direction={sortOrder}
                  onSort={setSort}
                  className="!px-3 !py-2"
                />
                <SortableTableHeader
                  label="Dept"
                  sortKey="department"
                  activeSort={sortBy}
                  direction={sortOrder}
                  onSort={setSort}
                  className="!px-3 !py-2"
                />
                <SortableTableHeader
                  label="Date/Time"
                  sortKey="appointment_date"
                  activeSort={sortBy}
                  direction={sortOrder}
                  onSort={setSort}
                  className="!px-3 !py-2"
                />
                <SortableTableHeader
                  label="Token"
                  sortKey="token"
                  activeSort={sortBy}
                  direction={sortOrder}
                  onSort={setSort}
                  className="!px-3 !py-2"
                />
                <SortableTableHeader
                  label="Status"
                  sortKey="status"
                  activeSort={sortBy}
                  direction={sortOrder}
                  onSort={setSort}
                  className="!px-3 !py-2"
                />
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Reminders
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((appt) => {
                const a = appt as AppointmentRow & AppointmentWorkflow;
                const isActing = acting?.id === a.id;
                return (
                  <tr key={a.id} className="border-b hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">
                      {a.patient_name ?? "—"}
                    </td>
                    <td className="px-3 py-2">{a.phone ?? "—"}</td>
                    <td className="px-3 py-2">{a.doctor_name ?? "—"}</td>
                    <td className="px-3 py-2">
                      {(a as AppointmentWorkflow).department ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {fmtDate(a.appointment_date)} {a.appointment_time}
                    </td>
                    <td className="px-3 py-2">
                      {(a as AppointmentWorkflow).token_number ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={a.status?.toUpperCase()} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${(a as unknown as Record<string, unknown>).reminder_24h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}
                          title="24h reminder"
                        >
                          24h
                        </span>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${(a as unknown as Record<string, unknown>).reminder_1h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}
                          title="1h reminder"
                        >
                          1h
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {a.status?.toUpperCase() === "SCHEDULED" && (
                          <button
                            disabled={isActing}
                            onClick={() => doAction(a.id, "confirm")}
                            className="text-xs bg-teal-600 text-white px-2 py-0.5 rounded hover:bg-teal-700 disabled:opacity-50"
                          >
                            Confirm
                          </button>
                        )}
                        {a.status?.toUpperCase() === "CONFIRMED" && (
                          <button
                            disabled={isActing}
                            onClick={() => doAction(a.id, "complete")}
                            className="text-xs bg-green-600 text-white px-2 py-0.5 rounded hover:bg-green-700 disabled:opacity-50"
                          >
                            Complete
                          </button>
                        )}
                        {!["COMPLETED", "CANCELLED", "NO_SHOW"].includes(
                          a.status?.toUpperCase(),
                        ) && (
                          <button
                            disabled={isActing}
                            onClick={() => doAction(a.id, "no-show")}
                            className="text-xs bg-gray-500 text-white px-2 py-0.5 rounded hover:bg-gray-600 disabled:opacity-50"
                          >
                            No-Show
                          </button>
                        )}
                        {!["COMPLETED", "CANCELLED"].includes(
                          a.status?.toUpperCase(),
                        ) && (
                          <button
                            disabled={isActing}
                            onClick={() => {
                              const r = prompt("Cancellation reason?");
                              if (r !== null)
                                doAction(a.id, "cancel", { reason: r });
                            }}
                            className="text-xs bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600 disabled:opacity-50"
                          >
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
      {data && (
        <PaginationControls
          pagination={data.pagination}
          itemLabel="appointments"
        />
      )}
    </div>
  );
}

type AppointmentSortKey =
  | "patient"
  | "phone"
  | "doctor"
  | "department"
  | "appointment_date"
  | "token"
  | "status";

function getAppointmentSortValue(
  appt: AppointmentRow & Partial<AppointmentWorkflow>,
  key: AppointmentSortKey,
): SortValue {
  switch (key) {
    case "patient":
      return appt.patient_name;
    case "phone":
      return (appt as AppointmentRow & { phone?: string }).phone;
    case "doctor":
      return appt.doctor_name;
    case "department":
      return appt.department;
    case "token":
      return (appt as AppointmentRow & { token_number?: string | number })
        .token_number;
    case "status":
      return appt.status;
    case "appointment_date":
    default:
      return `${appt.appointment_date ?? ""} ${appt.appointment_time ?? ""}`;
  }
}
