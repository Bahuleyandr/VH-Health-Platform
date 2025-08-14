// src/app/dashboard/system-logs/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI } from "@/lib/api";
import type { AuditLog, SystemLog, LogFilters } from "@/lib/types";
import { useSearchParams, useRouter } from "next/navigation";
import { AuditLogsTable } from "./components/AuditLogsTable";
import { SystemLogsTable } from "./components/SystemLogsTable";
import { LogFilters as LogFiltersComponent } from "./components/LogFilters";
import { LogStats } from "./components/LogStats";
import { LogMonitor } from "./components/LogMonitor";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { LogLevelIndicator } from "./components/LogLevelIndicator";

type Pagination = {
  totalPages?: number;
  currentPage?: number;
};

type LogsResponse<T> = {
  logs?: T[];
  pagination?: Pagination;
};

function SystemLogsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentTab = searchParams.get("tab") || "audit";

  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const itemsPerPage = 20;

  // Auto-refresh state
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30); // seconds

  const fetchLogs = useCallback(
    async (page: number, filters?: LogFilters) => {
      try {
        setLoading(true);
        setError(null);

        // Build query params
        const queryParams = new URLSearchParams();
        queryParams.set("page", page.toString());
        queryParams.set("limit", itemsPerPage.toString());

        // Add filters to query params
        if (filters?.dateRange) queryParams.set("dateRange", filters.dateRange);
        if (filters?.search) queryParams.set("search", filters.search);
        if (filters?.level) queryParams.set("level", filters.level);
        if (filters?.action) queryParams.set("action", filters.action);

        // Fetch both types of logs in parallel (typed)
        const [auditResponse, systemResponse] = await Promise.all([
          fetchAdminAPI<LogsResponse<AuditLog>>(
            `/logs/audit?${queryParams.toString()}`,
          ),
          fetchAdminAPI<LogsResponse<SystemLog>>(
            `/logs/system?${queryParams.toString()}`,
          ),
        ]);

        setAuditLogs(auditResponse.logs ?? []);
        setSystemLogs(systemResponse.logs ?? []);

        // Set pagination info based on current tab
        const response =
          currentTab === "audit" ? auditResponse : systemResponse;
        if (response.pagination) {
          setTotalPages(response.pagination.totalPages ?? 1);
          setCurrentPage(response.pagination.currentPage ?? page);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to fetch logs");
      } finally {
        setLoading(false);
      }
    },
    [currentTab, itemsPerPage],
  );

  useEffect(() => {
    const page = searchParams.get("page");
    const pageNumber = page ? parseInt(page, 10) : 1;

    // Get filters from URL params
    const filters: LogFilters = {
      dateRange: searchParams.get("dateRange") || "",
      search: searchParams.get("search") || "",
      level: searchParams.get("level") || "",
      action: searchParams.get("action") || "",
    };

    fetchLogs(pageNumber, filters);
  }, [searchParams, currentTab, fetchLogs]);

  // Auto-refresh functionality
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    if (autoRefresh) {
      interval = setInterval(() => {
        const filters: LogFilters = {
          dateRange: searchParams.get("dateRange") || "",
          search: searchParams.get("search") || "",
          level: searchParams.get("level") || "",
          action: searchParams.get("action") || "",
        };
        fetchLogs(currentPage, filters);
      }, refreshInterval * 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, refreshInterval, currentPage, searchParams, fetchLogs]);

  const handleTabChange = useCallback(
    (tab: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      url.searchParams.set("page", "1"); // Reset to first page on tab change
      router.push(url.pathname + url.search);
    },
    [router],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      const url = new URL(window.location.href);
      url.searchParams.set("page", newPage.toString());
      router.push(url.pathname + url.search);
    },
    [router],
  );

  const handleExport = useCallback(async () => {
    try {
      const queryParams = new URLSearchParams(window.location.search);
      const endpoint =
        currentTab === "audit" ? "/logs/audit/export" : "/logs/system/export";

      const response = await fetchAdminAPI<unknown>(
        `${endpoint}?${queryParams.toString()}`,
      );

      // Create a blob and download
      const blob = new Blob([JSON.stringify(response, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentTab}_logs_${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert("Failed to export logs");
    }
  }, [currentTab]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      switch (e.key.toLowerCase()) {
        case "r": {
          e.preventDefault();
          const filters: LogFilters = {
            dateRange: searchParams.get("dateRange") || "",
            search: searchParams.get("search") || "",
            level: searchParams.get("level") || "",
            action: searchParams.get("action") || "",
          };
          fetchLogs(currentPage, filters);
          break;
        }
        case "a":
          e.preventDefault();
          setAutoRefresh((prev) => !prev);
          break;
        case "e":
          e.preventDefault();
          handleExport();
          break;
        case "tab":
          e.preventDefault();
          handleTabChange(currentTab === "audit" ? "system" : "audit");
          break;
        case "arrowleft":
          if (currentPage > 1) {
            e.preventDefault();
            handlePageChange(currentPage - 1);
          }
          break;
        case "arrowright":
          if (currentPage < totalPages) {
            e.preventDefault();
            handlePageChange(currentPage + 1);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [
    autoRefresh,
    currentPage,
    totalPages,
    currentTab,
    searchParams,
    fetchLogs,
    handleExport,
    handleTabChange,
    handlePageChange,
  ]);

  const handleFilterChange = (filters: LogFilters) => {
    const url = new URL(window.location.href);

    // Reset to page 1 when filters change
    url.searchParams.set("page", "1");

    // Set filter params
    (Object.keys(filters) as (keyof LogFilters)[]).forEach((key) => {
      const value = filters[key];
      if (value) {
        url.searchParams.set(String(key), value);
      } else {
        url.searchParams.delete(String(key));
      }
    });

    router.push(url.pathname + url.search);
  };

  if (loading && auditLogs.length === 0 && systemLogs.length === 0) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900">
          System & Audit Logs
        </h1>
        <div className="flex items-center gap-4">
          {/* Auto-refresh toggle */}
          <div className="flex items-center gap-2">
            <label className="flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="h-4 w-4 text-blue-600 rounded border-gray-300"
              />
              <span className="ml-2 text-sm text-gray-700">Auto-refresh</span>
            </label>
            {autoRefresh ? (
              <select
                value={refreshInterval}
                onChange={(e) =>
                  setRefreshInterval(parseInt(e.target.value, 10))
                }
                className="text-sm border border-gray-300 rounded px-2 py-1"
              >
                <option value="10">10s</option>
                <option value="30">30s</option>
                <option value="60">1m</option>
                <option value="300">5m</option>
              </select>
            ) : null}
          </div>

          <button
            onClick={handleExport}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors flex items-center gap-2"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
              />
            </svg>
            Export Logs
          </button>

          <KeyboardShortcuts />
        </div>
      </div>

      {error ? (
        <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      ) : null}

      {/* Tab Navigation */}
      <div className="mb-6 border-b border-gray-200">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          <button
            onClick={() => handleTabChange("audit")}
            className={`${
              currentTab === "audit"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors`}
          >
            Audit Logs ({auditLogs.length})
          </button>
          <button
            onClick={() => handleTabChange("system")}
            className={`${
              currentTab === "system"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors`}
          >
            System Logs ({systemLogs.length})
          </button>
        </nav>
      </div>

      {/* Stats */}
      <LogStats
        logs={currentTab === "audit" ? auditLogs : systemLogs}
        type={currentTab as "audit" | "system"}
      />

      {/* Filters */}
      <LogFiltersComponent
        onFilterChange={handleFilterChange}
        logType={currentTab as "audit" | "system"}
      />

      {/* Content */}
      <div className="mt-6">
        {currentTab === "audit" ? (
          <AuditLogsTable logs={auditLogs} loading={loading} />
        ) : (
          <>
            <LogLevelIndicator logs={systemLogs} />
            <SystemLogsTable logs={systemLogs} loading={loading} />
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 ? (
        <div className="mt-6 flex items-center justify-between">
          <div className="text-sm text-gray-700">
            Showing page {currentPage} of {totalPages}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${
                currentPage === 1
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              Previous
            </button>

            {/* Page numbers */}
            <div className="flex gap-1">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pageNum;
                if (totalPages <= 5) pageNum = i + 1;
                else if (currentPage <= 3) pageNum = i + 1;
                else if (currentPage >= totalPages - 2)
                  pageNum = totalPages - 4 + i;
                else pageNum = currentPage - 2 + i;

                return (
                  <button
                    key={pageNum}
                    onClick={() => handlePageChange(pageNum)}
                    className={`px-3 py-1 rounded-md transition-colors ${
                      currentPage === pageNum
                        ? "bg-blue-600 text-white"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${
                currentPage === totalPages
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {/* Real-time log monitor */}
      <LogMonitor
        logs={currentTab === "audit" ? auditLogs : systemLogs}
        type={currentTab as "audit" | "system"}
        isActive={autoRefresh}
      />
    </div>
  );
}

export default function SystemLogsPage() {
  // Wrap content with useSearchParams in Suspense to satisfy Next's rule
  return (
    <Suspense fallback={<div className="p-6">Loading logs…</div>}>
      <SystemLogsContent />
    </Suspense>
  );
}
