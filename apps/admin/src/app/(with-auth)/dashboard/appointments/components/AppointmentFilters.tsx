// src/app/(with-auth)/dashboard/appointments/components/AppointmentFilters.tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";

// A simple debounce utility to avoid spamming requests while typing
function useDebounce(value: string, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);
  return debouncedValue;
}

export function AppointmentFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // State for our inputs
  const [status, setStatus] = useState(searchParams.get("status") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");

  const debouncedSearch = useDebounce(search, 500);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);

    if (status) {
      params.set("status", status);
    } else {
      params.delete("status");
    }

    if (debouncedSearch) {
      params.set("search", debouncedSearch);
    } else {
      params.delete("search");
    }

    params.set("page", "1"); // Reset to page 1 on filter change

    router.push(`/dashboard/appointments?${params.toString()}`);
  }, [status, debouncedSearch, router, searchParams]);

  return (
    <div className="mb-4 flex gap-4 items-center bg-card p-3 rounded-lg shadow">
      <input
        type="text"
        placeholder="Search by patient or doctor..."
        className="border p-2 rounded w-full"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <select
        className="border p-2 rounded"
        value={status}
        onChange={(e) => setStatus(e.target.value)}
      >
        <option value="">All Statuses</option>
        <option value="SCHEDULED">Scheduled</option>
        <option value="COMPLETED">Completed</option>
        <option value="CANCELLED">Cancelled</option>
        <option value="PENDING">Pending</option>
      </select>
    </div>
  );
}
