// src/app/dashboard/users/components/UserFilters.tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';

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

export function UserFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // State for our inputs
  const [role, setRole] = useState(searchParams.get('role') || '');
  const [search, setSearch] = useState(searchParams.get('search') || '');
  
  // Debounce the search term to avoid excessive API calls
  const debouncedSearch = useDebounce(search, 500);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    
    // Update role if it changes
    if (role) {
      params.set('role', role);
    } else {
      params.delete('role');
    }

    // Update search if debounced search term changes
    if (debouncedSearch) {
      params.set('search', debouncedSearch);
    } else {
      params.delete('search');
    }

    // Reset to page 1 whenever filters change
    params.set('page', '1');

    // Push the new URL
    router.push(`/dashboard/users?${params.toString()}`);
    
  }, [role, debouncedSearch, router, searchParams]);


  return (
    <div className="mb-4 flex gap-4 items-center bg-white p-3 rounded-lg shadow">
      <input
        type="text"
        placeholder="Search by name, email, phone..."
        className="border p-2 rounded w-full"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <select
        className="border p-2 rounded"
        value={role}
        onChange={(e) => setRole(e.target.value)}
      >
        <option value="">All Roles</option>
        <option value="DOCTOR">Doctor</option>
        <option value="PATIENT">Patient</option>
        <option value="NURSE">Nurse</option>
        <option value="ADMIN">Admin</option>
        <option value="PHARMACIST">Pharmacist</option>
      </select>
    </div>
  );
}