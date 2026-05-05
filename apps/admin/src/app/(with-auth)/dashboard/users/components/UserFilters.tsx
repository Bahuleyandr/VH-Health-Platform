// src/app/(with-auth)/dashboard/users/components/UserFilters.tsx
"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useCallback } from "react";
import { useDebouncedCallback } from "use-debounce"; // npm install use-debounce

const ROLE_OPTIONS = [
  "ADMIN",
  "SUPER_ADMIN",
  "DOCTOR",
  "PATIENT",
  "NURSING_STAFF",
  "PHARMACY_STAFF",
  "LAB_STAFF",
  "HR_STAFF",
  "GENERAL_STAFF",
  "RECEPTIONIST",
  "TECHNICIAN",
];

export function UserFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Initialize state from URL params
  const [role, setRole] = useState(searchParams.get("role") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");

  // Create a debounced search handler
  const debouncedSearch = useDebouncedCallback((value: string) => {
    const params = new URLSearchParams(searchParams);
    const trimmed = value.trim();

    if (trimmed.length >= 2) {
      params.set("search", trimmed);
    } else {
      params.delete("search");
    }

    params.set("page", "1"); // Reset to page 1
    router.push(`${pathname}?${params.toString()}`);
  }, 500);

  // Handle role change immediately
  const handleRoleChange = useCallback(
    (value: string) => {
      setRole(value);
      const params = new URLSearchParams(searchParams);

      if (value) {
        params.set("role", value);
      } else {
        params.delete("role");
      }

      params.set("page", "1"); // Reset to page 1
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, router, searchParams],
  );

  // Handle search input change
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      debouncedSearch(value);
    },
    [debouncedSearch],
  );

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg bg-white p-3 shadow dark:bg-card sm:flex-row sm:items-center">
      <input
        type="text"
        placeholder="Search by name, email, phone..."
        className="min-w-0 flex-1 rounded border border-input bg-background p-2 text-foreground"
        value={search}
        onChange={(e) => handleSearchChange(e.target.value)}
      />
      <select
        className="rounded border border-input bg-background p-2 text-foreground sm:w-44"
        value={role}
        onChange={(e) => handleRoleChange(e.target.value)}
      >
        <option value="">All Roles</option>
        {ROLE_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </div>
  );
}
