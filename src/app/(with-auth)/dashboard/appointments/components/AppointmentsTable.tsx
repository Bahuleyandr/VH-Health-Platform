// src/app/(with-auth)/dashboard/appointments/components/AppointmentsTable.tsx
import type { Appointment } from "@/lib/types";

type AppointmentRow = Appointment & {
  patient_name?: string;
  doctor_name?: string;
  department?: string;
};

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
  if (isLoading) {
    return <div className="p-6 text-center text-muted-foreground">Loading appointments...</div>;
  }

  if (error) {
    return <div className="p-6 text-center text-destructive">{error}</div>;
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-border">
        <thead className="bg-muted">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
              Patient & Doctor
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
              Appointment Date
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
              Department
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
              Status
            </th>
          </tr>
        </thead>

        <tbody className="bg-white divide-y divide-border">
          {appointments.map((appt) => (
            <tr key={appt.id}>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-foreground">
                  {appt.patient_name ?? `Patient #${appt.patient_id}`}
                </div>
                <div className="text-sm text-muted-foreground">
                  Dr. {appt.doctor_name ?? `#${appt.doctor_id}`}
                </div>
              </td>

              <td className="px-6 py-4 whitespace-nowrap text-sm text-foreground">
                {formatApptDate(appt)}
              </td>

              <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                {appt.department ?? "-"}
              </td>

              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    statusColorMap[appt.status]
                  }`}
                >
                  {appt.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
