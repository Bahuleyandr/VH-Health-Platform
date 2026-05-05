// src/app/(with-auth)/dashboard/appointments/components/AppointmentsTable.tsx
"use client";

import { useMemo, useState } from "react";
import {
  ClientTablePagination,
  compareTableValues,
  ManagedTableToolbar,
  paginateRows,
  SortableTableHeader,
  type SortDirection,
  type SortValue,
} from "@/components/table/client";
import type { Appointment } from "@/lib/types";

type AppointmentRow = Appointment & {
  patient_name?: string;
  doctor_name?: string;
  department?: string;
};

type AppointmentSortKey = "patient" | "date" | "department" | "status";

const statusColorMap: Record<Appointment["status"] | "PENDING", string> = {
  SCHEDULED: "bg-primary/10 text-primary",
  COMPLETED: "bg-success/10 text-success",
  CANCELLED: "bg-destructive/10 text-destructive",
  PENDING: "bg-warning/10 text-warning",
};

function formatApptDate(appt: AppointmentRow) {
  // Try to combine date + time if time exists; fall back gracefully
  const iso = appt.appointment_time
    ? `${appt.appointment_date}T${appt.appointment_time}`
    : appt.appointment_date;

  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) {
    return [appt.appointment_date, appt.appointment_time]
      .filter(Boolean)
      .join(" ");
  }
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AppointmentsTable({
  appointments,
  isLoading,
  error,
}: {
  appointments: AppointmentRow[];
  isLoading?: boolean;
  error?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<AppointmentSortKey>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = appointments.filter((appt) => {
      if (!query) return true;
      return [
        appt.patient_name ?? `Patient #${appt.patient_id}`,
        appt.doctor_name ?? `#${appt.doctor_id}`,
        appt.department,
        appt.status,
        appt.appointment_date,
        appt.appointment_time,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    filtered.sort((a, b) => {
      const result = compareTableValues(
        getAppointmentSortValue(a, sortKey),
        getAppointmentSortValue(b, sortKey),
      );
      return sortDirection === "asc" ? result : -result;
    });

    return filtered;
  }, [appointments, search, sortDirection, sortKey]);

  const paged = paginateRows(rows, page, pageSize);

  const handleSort = (key: AppointmentSortKey) => {
    setSortDirection((current) =>
      sortKey === key && current === "asc" ? "desc" : "asc",
    );
    setSortKey(key);
    setPage(1);
  };

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Loading appointments...
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-center text-destructive">{error}</div>;
  }

  return (
    <>
      <ManagedTableToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        placeholder="Search appointments by patient, doctor, department, status..."
        countLabel={`${rows.length} of ${appointments.length} appointments`}
      />

      <div className="overflow-hidden rounded-lg bg-white shadow">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <SortableTableHeader
                  label="Patient & Doctor"
                  sortKey="patient"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Appointment Date"
                  sortKey="date"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Department"
                  sortKey="department"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Status"
                  sortKey="status"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
              </tr>
            </thead>

            <tbody className="divide-y divide-border bg-white">
              {paged.rows.map((appt) => (
                <tr key={appt.id}>
                  <td className="whitespace-nowrap px-6 py-4">
                    <div className="text-sm font-medium text-foreground">
                      {appt.patient_name ?? `Patient #${appt.patient_id}`}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Dr. {appt.doctor_name ?? `#${appt.doctor_id}`}
                    </div>
                  </td>

                  <td className="whitespace-nowrap px-6 py-4 text-sm text-foreground">
                    {formatApptDate(appt)}
                  </td>

                  <td className="whitespace-nowrap px-6 py-4 text-sm text-muted-foreground">
                    {appt.department ?? "-"}
                  </td>

                  <td className="whitespace-nowrap px-6 py-4">
                    <span
                      className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                        statusColorMap[appt.status] ?? statusColorMap.PENDING
                      }`}
                    >
                      {appt.status}
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    No appointments match the current search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ClientTablePagination
        page={paged.page}
        pageSize={pageSize}
        total={rows.length}
        onPageChange={setPage}
        onPageSizeChange={(value) => {
          setPageSize(value);
          setPage(1);
        }}
        itemLabel="appointments"
      />
    </>
  );
}

function getAppointmentSortValue(
  appointment: AppointmentRow,
  key: AppointmentSortKey,
): SortValue {
  switch (key) {
    case "patient":
      return appointment.patient_name ?? appointment.patient_id;
    case "department":
      return appointment.department;
    case "status":
      return appointment.status;
    case "date":
    default:
      return `${appointment.appointment_date ?? ""} ${
        appointment.appointment_time ?? ""
      }`;
  }
}
