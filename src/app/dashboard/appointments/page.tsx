'use client';

// src/app/dashboard/appointments/page.tsx
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { fetchAdminAPI } from '@/lib/api';
import type { Appointment } from '@/lib/types';
import { AppointmentsTable } from './components/AppointmentsTable';
import { PaginationControls } from '../users/components/PaginationControls';
import { AppointmentFilters } from './components/AppointmentFilters';

// Match the row shape used by AppointmentsTable (supports joined fields)
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

// Type guards / normalizer for flexible backend responses
function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function normalizeResponse(response: unknown, page: number): AppointmentsAPIResponse {
  // Case 1: Array response
  if (Array.isArray(response)) {
    const total = response.length;
    const limit = 10;
    return {
      appointments: response as AppointmentRow[],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  // Case 2: Object with { appointments?, pagination?, total?, hasNext? }
  if (isObj(response)) {
    const appointments =
      (Array.isArray(response.appointments) ? response.appointments : []) as AppointmentRow[];

    // If backend returned a top-level array-ish structure in a property named 'data'
    const fallbackAppointments =
      Array.isArray((response as any).data) ? ((response as any).data as AppointmentRow[]) : [];

    const list = appointments.length ? appointments : fallbackAppointments;

    const total = Number((response as any).total ?? list.length ?? 0) || 0;
    const limit = Number((response as any).pagination?.limit ?? 10) || 10;

    const pagination: Pagination = {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: Boolean((response as any).hasNext ?? page * limit < total),
      hasPrev: page > 1,
    };

    return {
      appointments: list.length ? list : [],
      pagination,
    };
  }

  // Case 3: Unknown — return empty
  return {
    appointments: [],
    pagination: {
      page,
      limit: 10,
      total: 0,
      totalPages: 1,
      hasNext: false,
      hasPrev: page > 1,
    },
  };
}

function AppointmentsContent() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<AppointmentsAPIResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchAppointments = async () => {
      try {
        setLoading(true);
        setError(null);

        const queryParams = new URLSearchParams();
        const pageStr = searchParams.get('page') || '1';
        const page = Number.parseInt(pageStr, 10) || 1;

        const status = searchParams.get('status');
        const search = searchParams.get('search');

        queryParams.set('page', String(page));
        if (status) queryParams.set('status', status);
        if (search) queryParams.set('search', search);

        const path = `/appointments/manage?${queryParams.toString()}`;

        // Type as unknown; we normalize right after
        const response = await fetchAdminAPI<unknown>(path);
        const normalized = normalizeResponse(response, page);

        if (!cancelled) setData(normalized);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch appointments');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchAppointments();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
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

  if (!data) return <div>No data available</div>;

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
