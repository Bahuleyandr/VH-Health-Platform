// src/app/dashboard/appointments/page.tsx

import { getAppointments } from "@/lib/api";
import { AppointmentsAPIResponse } from "@/lib/types";
import { AppointmentsTable } from "./components/AppointmentsTable";
import { Suspense } from "react";
import { PaginationControls } from "../users/components/PaginationControls";
import { AppointmentFilters } from "./components/AppointmentFilters"; // Import the new component

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const queryParams = new URLSearchParams();
  if (searchParams.page) queryParams.set('page', searchParams.page as string);
  if (searchParams.status) queryParams.set('status', searchParams.status as string);
  if (searchParams.search) queryParams.set('search', searchParams.search as string);

  if (!queryParams.has('page')) {
    queryParams.set('page', '1');
  }

  // Fetch data using the query params
  const data: AppointmentsAPIResponse = await getAppointments(queryParams);
  const { appointments, pagination } = data;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Appointment Management</h2>
      
      {/* Add the AppointmentFilters component here */}
      <Suspense fallback={<div>Loading filters...</div>}>
        <AppointmentFilters />
      </Suspense>
      
      <Suspense fallback={<div>Loading appointments...</div>}>
        <AppointmentsTable appointments={appointments} />
      </Suspense>
      
      <PaginationControls pagination={pagination} />
    </div>
  );
}