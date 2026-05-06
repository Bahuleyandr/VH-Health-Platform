// src/app/(with-auth)/dashboard/system-logs/hooks/useSystemLogsData.ts
// Data + pagination + auto-refresh + keyboard-shortcut state for the
// system-logs page. Extracted out of page.tsx in the god-split so the
// orchestrator becomes a thin shell and the hook is testable in
// isolation.

"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchAdminAPI } from "@/lib/api";
import type { AuditLog, SystemLog, LogFilters } from "@/lib/types";

type Pagination = {
  totalPages?: number;
  currentPage?: number;
};

type LogsResponse<T> = {
  logs?: T[];
  pagination?: Pagination;
};

const DEFAULT_ITEMS_PER_PAGE = 10;

export interface SystemLogsData {
  currentTab: string;
  auditLogs: AuditLog[];
  systemLogs: SystemLog[];
  loading: boolean;
  error: string | null;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  autoRefresh: boolean;
  refreshInterval: number;
  setAutoRefresh: (v: boolean) => void;
  setRefreshInterval: (n: number) => void;
  handleTabChange: (tab: string) => void;
  handlePageChange: (newPage: number) => void;
  handlePageSizeChange: (pageSize: number) => void;
  handleFilterChange: (filters: LogFilters) => void;
  handleExport: () => Promise<void>;
}

export function useSystemLogsData(): SystemLogsData {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentTab = searchParams.get("tab") || "audit";
  const requestedPageSize = parseInt(
    searchParams.get("limit") || String(DEFAULT_ITEMS_PER_PAGE),
    10,
  );
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.max(1, requestedPageSize)
    : DEFAULT_ITEMS_PER_PAGE;

  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30);

  const fetchLogs = useCallback(
    async (page: number, filters?: LogFilters) => {
      try {
        setLoading(true);
        setError(null);

        const queryParams = new URLSearchParams();
        queryParams.set("page", page.toString());
        queryParams.set("limit", pageSize.toString());

        if (filters?.dateRange) queryParams.set("dateRange", filters.dateRange);
        if (filters?.search) queryParams.set("search", filters.search);
        if (filters?.level) queryParams.set("level", filters.level);
        if (filters?.action) queryParams.set("action", filters.action);

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
    [currentTab, pageSize],
  );

  // Initial + filter-driven fetch.
  useEffect(() => {
    const page = searchParams.get("page");
    const pageNumber = page ? parseInt(page, 10) : 1;

    const filters: LogFilters = {
      dateRange: searchParams.get("dateRange") || "",
      search: searchParams.get("search") || "",
      level: searchParams.get("level") || "",
      action: searchParams.get("action") || "",
    };

    fetchLogs(pageNumber, filters);
  }, [searchParams, currentTab, fetchLogs]);

  // Auto-refresh ticker.
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
      url.searchParams.set("page", "1");
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

  const handlePageSizeChange = useCallback(
    (nextPageSize: number) => {
      const url = new URL(window.location.href);
      url.searchParams.set("page", "1");
      url.searchParams.set("limit", nextPageSize.toString());
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

  // Keyboard shortcuts — r=refresh, a=toggle auto-refresh, e=export,
  // tab=switch tab, arrows=paginate. Skip when the user is typing in an
  // input/textarea so the shortcuts don't steal keystrokes.
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
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

  const handleFilterChange = useCallback(
    (filters: LogFilters) => {
      const url = new URL(window.location.href);
      url.searchParams.set("page", "1");

      (Object.keys(filters) as (keyof LogFilters)[]).forEach((key) => {
        const value = filters[key];
        if (value) {
          url.searchParams.set(String(key), value);
        } else {
          url.searchParams.delete(String(key));
        }
      });

      router.push(url.pathname + url.search);
    },
    [router],
  );

  return {
    currentTab,
    auditLogs,
    systemLogs,
    loading,
    error,
    currentPage,
    totalPages,
    pageSize,
    autoRefresh,
    refreshInterval,
    setAutoRefresh,
    setRefreshInterval,
    handleTabChange,
    handlePageChange,
    handlePageSizeChange,
    handleFilterChange,
    handleExport,
  };
}
