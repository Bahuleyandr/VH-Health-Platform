// src/app/dashboard/appointments/components/AppointmentsTable.tsx
import type { Appointment } from "@/lib/types";

type AppointmentRow = Appointment & {
  patient_name?: string;
  doctor_name?: string;
  department?: string;
};

const statusColorMap: Record<Appointment["status"] | "PENDING", string> = {
  SCHEDULED: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  PENDING: "bg-yellow-100 text-yellow-800",
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
}: {
  appointments: AppointmentRow[];
}) {
  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Patient & Doctor
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Appointment Date
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Department
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Status
            </th>
          </tr>
        </thead>

        <tbody className="bg-white divide-y divide-gray-200">
          {appointments.map((appt) => (
            <tr key={appt.id}>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">
                  {appt.patient_name ?? `Patient #${appt.patient_id}`}
                </div>
                <div className="text-sm text-gray-500">
                  Dr. {appt.doctor_name ?? `#${appt.doctor_id}`}
                </div>
              </td>

              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {formatApptDate(appt)}
              </td>

              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
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
