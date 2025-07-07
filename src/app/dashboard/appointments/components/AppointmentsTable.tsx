// src/app/dashboard/appointments/components/AppointmentsTable.tsx

import { Appointment } from "@/lib/types";

const statusColorMap = {
  SCHEDULED: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
};

export function AppointmentsTable({ appointments }: { appointments: Appointment[] }) {
  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Patient & Doctor</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Appointment Date</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Department</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {appointments.map((appt) => (
            <tr key={appt.id}>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">{appt.patient_name}</div>
                <div className="text-sm text-gray-500">Dr. {appt.doctor_name}</div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {new Date(appt.appointment_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{appt.department}</td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColorMap[appt.status]}`}>
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