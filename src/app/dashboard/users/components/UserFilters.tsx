// src/app/dashboard/users/components/UserFilters.tsx
'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useState, useCallback } from 'react';
import { useDebouncedCallback } from 'use-debounce'; // npm install use-debounce

export function UserFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Initialize state from URL params
  const [role, setRole] = useState(searchParams.get('role') || '');
  const [search, setSearch] = useState(searchParams.get('search') || '');

  // Create a debounced search handler
  const debouncedSearch = useDebouncedCallback((value: string) => {
    const params = new URLSearchParams(searchParams);
    
    if (value) {
      params.set('search', value);
    } else {
      params.delete('search');
    }
    
    params.set('page', '1'); // Reset to page 1
    router.push(`${pathname}?${params.toString()}`);
  }, 500);

  // Handle role change immediately
  const handleRoleChange = useCallback((value: string) => {
    setRole(value);
    const params = new URLSearchParams(searchParams);
    
    if (value) {
      params.set('role', value);
    } else {
      params.delete('role');
    }
    
    params.set('page', '1'); // Reset to page 1
    router.push(`${pathname}?${params.toString()}`);
  }, [pathname, router, searchParams]);

  // Handle search input change
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    debouncedSearch(value);
  }, [debouncedSearch]);

  return (
    <div className="mb-4 flex gap-4 items-center bg-white p-3 rounded-lg shadow">
      <input
        type="text"
        placeholder="Search by name, email, phone..."
        className="border p-2 rounded w-full"
        value={search}
        onChange={(e) => handleSearchChange(e.target.value)}
      />
      <select
        className="border p-2 rounded"
        value={role}
        onChange={(e) => handleRoleChange(e.target.value)}
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