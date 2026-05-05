// src/app/(with-auth)/dashboard/system-logs/page.tsx
// Thin orchestrator — data + handlers come from useSystemLogsData,
// UI slices (header, tab-nav, pagination) are each their own component.
// See the god-page pattern note in apps/admin/CLAUDE.md.

"use client";

import { Suspense } from "react";
import { AuditLogsTable } from "./components/AuditLogsTable";
import { SystemLogsTable } from "./components/SystemLogsTable";
import { LogFilters as LogFiltersComponent } from "./components/LogFilters";
import { LogStats } from "./components/LogStats";
import { LogMonitor } from "./components/LogMonitor";
import { LogLevelIndicator } from "./components/LogLevelIndicator";
import { LogsPageHeader } from "./components/LogsPageHeader";
import { LogsTabNav } from "./components/LogsTabNav";
import { LogsPagination } from "./components/LogsPagination";
import { useSystemLogsData } from "./hooks/useSystemLogsData";

function SystemLogsContent() {
  const {
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
  } = useSystemLogsData();

  if (loading && auditLogs.length === 0 && systemLogs.length === 0) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  const activeLogs = currentTab === "audit" ? auditLogs : systemLogs;
  const activeType = currentTab as "audit" | "system";

  return (
    <div className="p-6">
      <LogsPageHeader
        autoRefresh={autoRefresh}
        refreshInterval={refreshInterval}
        onAutoRefreshChange={setAutoRefresh}
        onRefreshIntervalChange={setRefreshInterval}
        onExport={handleExport}
      />

      {error ? (
        <div className="mb-4 bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded">
          Error: {error}
        </div>
      ) : null}

      <LogsTabNav
        currentTab={currentTab}
        auditCount={auditLogs?.length ?? 0}
        systemCount={systemLogs?.length ?? 0}
        onTabChange={handleTabChange}
      />

      <LogStats logs={activeLogs} type={activeType} />

      <LogFiltersComponent
        onFilterChange={handleFilterChange}
        logType={activeType}
      />

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

      <LogsPagination
        currentPage={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
      />

      <LogMonitor logs={activeLogs} type={activeType} isActive={autoRefresh} />
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
