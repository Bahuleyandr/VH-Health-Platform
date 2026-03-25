// src/app/(with-auth)/dashboard/system-logs/components/LogFilters.tsx
"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { LogFilters as LogFiltersType } from "@/lib/types";

interface LogFiltersProps {
  onFilterChange: (filters: LogFiltersType) => void;
  logType: "audit" | "system";
}

const AUDIT_ACTIONS = [
  "USER_LOGIN",
  "USER_LOGOUT",
  "USER_CREATE",
  "USER_UPDATE",
  "USER_DELETE",
  "APPOINTMENT_CREATE",
  "APPOINTMENT_UPDATE",
  "APPOINTMENT_CANCEL",
  "DOCTOR_CREATE",
  "DOCTOR_UPDATE",
  "DOCTOR_DELETE",
  "ADMIN_CREATE",
  "PERMISSION_UPDATE",
  "SETTINGS_UPDATE",
];

export function LogFilters({ onFilterChange, logType }: LogFiltersProps) {
  const searchParams = useSearchParams();
  const [dateRange, setDateRange] = useState("");
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("");
  const [action, setAction] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    setDateRange(searchParams.get("dateRange") || "");
    setSearch(searchParams.get("search") || "");
    setLevel(searchParams.get("level") || "");
    setAction(searchParams.get("action") || "");

    if (
      searchParams.get("dateRange") ||
      searchParams.get("search") ||
      searchParams.get("level") ||
      searchParams.get("action")
    ) {
      setShowFilters(true);
    }
  }, [searchParams]);

  const handleApplyFilters = () => {
    onFilterChange({
      dateRange,
      search,
      level: logType === "system" ? level : undefined,
      action: logType === "audit" ? action : undefined,
    });
  };

  const handleReset = () => {
    setDateRange("");
    setSearch("");
    setLevel("");
    setAction("");
    onFilterChange({});
  };

  const activeFilterCount = [dateRange, search, level, action].filter(
    Boolean,
  ).length;

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-4">
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-foreground"
        >
          <svg
            className={`w-5 h-5 transition-transform ${showFilters ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
          Filters
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {showFilters && (
        <div className="border-t p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Search */}
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
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyUp={(e) => e.key === "Enter" && handleApplyFilters()}
                placeholder={
                  logType === "audit"
                    ? "User ID, action, details..."
                    : "Message, service..."
                }
                className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {/* Date Range */}
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
                <option value="yesterday">Yesterday</option>
                <option value="week">Last 7 Days</option>
                <option value="month">Last 30 Days</option>
                <option value="quarter">Last 3 Months</option>
              </select>
            </div>

            {/* Log Level (System Logs only) */}
            {logType === "system" && (
              <div>
                <label
                  htmlFor="level"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  Log Level
                </label>
                <select
                  id="level"
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">All Levels</option>
                  <option value="ERROR">Error</option>
                  <option value="WARN">Warning</option>
                  <option value="INFO">Info</option>
                  <option value="DEBUG">Debug</option>
                </select>
              </div>
            )}

            {/* Action (Audit Logs only) */}
            {logType === "audit" && (
              <div>
                <label
                  htmlFor="action"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  Action
                </label>
                <select
                  id="action"
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                  className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">All Actions</option>
                  {AUDIT_ACTIONS.map((act) => (
                    <option key={act} value={act}>
                      {act.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Filter Actions */}
            <div className="flex items-end gap-2">
              <button
                onClick={handleApplyFilters}
                className="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
              >
                Apply
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
      )}
    </div>
  );
}
