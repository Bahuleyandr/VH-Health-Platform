// src/app/(with-auth)/dashboard/pharmacy/components/PharmacyFilters.tsx
"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

// Define proper type for filter changes
interface FilterChangeEvent {
  status?: string;
  dateRange?: string;
  search?: string;
}

interface PharmacyFiltersProps {
  onFilterChange: (filters: FilterChangeEvent) => void;
}

export function PharmacyFilters({ onFilterChange }: PharmacyFiltersProps) {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState("");
  const [dateRange, setDateRange] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  // Initialize filters from URL params
  useEffect(() => {
    setStatus(searchParams.get("status") || "");
    setDateRange(searchParams.get("dateRange") || "");
    setSearchTerm(searchParams.get("search") || "");
  }, [searchParams]);

  const handleFilterChange = () => {
    onFilterChange({
      status,
      dateRange,
      search: searchTerm,
    });
  };

  const handleReset = () => {
    setStatus("");
    setDateRange("");
    setSearchTerm("");
    onFilterChange({});
  };

  return (
    <div className="bg-white p-4 rounded-lg shadow mb-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div>
          <label
            htmlFor="search"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Search
          </label>
          <input
            type="text"
            id="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyUp={(e) => e.key === "Enter" && handleFilterChange()}
            placeholder="Order ID, Patient name..."
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <div>
          <label
            htmlFor="status"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Status
          </label>
          <select
            id="status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="dateRange"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Date Range
          </label>
          <select
            id="dateRange"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All Time</option>
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="quarter">This Quarter</option>
          </select>
        </div>

        <div className="flex items-end gap-2">
          <button
            onClick={handleFilterChange}
            className="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
          >
            Apply Filters
          </button>
          <button
            onClick={handleReset}
            className="px-4 py-2 border border-input text-foreground rounded-md hover:bg-muted transition-colors"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
