'use client';

// src/app/dashboard/appointments/page.tsx
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { fetchAdminAPI } from "@/lib/api";
import { AppointmentsAPIResponse } from "@/lib/types";
import { AppointmentsTable } from "./components/AppointmentsTable";
import { PaginationControls } from "../users/components/PaginationControls";
import { AppointmentFilters } from "./components/AppointmentFilters";

function AppointmentsContent() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<AppointmentsAPIResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAppointments = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const queryParams = new URLSearchParams();
        const page = searchParams.get('page') || '1';
        const status = searchParams.get('status');
        const search = searchParams.get('search');
        
        queryParams.set('page', page);
        if (status) queryParams.set('status', status);
        if (search) queryParams.set('search', search);

        const path = `/appointments/manage?${queryParams.toString()}`;
        const response = await fetchAdminAPI(path);
        
        // Transform the response to match our expected format
        const transformedData: AppointmentsAPIResponse = {
          appointments: response.appointments || response,
          pagination: response.pagination || {
            page: parseInt(page),
            limit: 10,
            total: response.total || 0,
            totalPages: Math.ceil((response.total || 0) / 10),
            hasNext: response.hasNext || false,
            hasPrev: parseInt(page) > 1
          }
        };
        
        setData(transformedData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch appointments');
      } finally {
        setLoading(false);
      }
    };

    fetchAppointments();
  }, [searchParams]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        Error: {error}
      </div>
    );
  }

  if (!data) {
    return <div>No data available</div>;
  }

  return (
    <>
      <AppointmentFilters />
      <AppointmentsTable appointments={data.appointments} />
      <PaginationControls pagination={data.pagination} />
    </>
  );
}

export default function AppointmentsPage() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">Appointment Management</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <AppointmentsContent />
      </Suspense>
    </div>
  );
}