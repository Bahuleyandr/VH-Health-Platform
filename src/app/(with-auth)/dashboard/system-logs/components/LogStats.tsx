// src/app/(with-auth)/dashboard/system-logs/components/LogStats.tsx
"use client";

import { AuditLog, SystemLog } from "@/lib/types";

interface LogStatsProps {
  logs: AuditLog[] | SystemLog[];
  type: "audit" | "system";
}

export function LogStats({ logs, type }: LogStatsProps) {
  if (type === "audit") {
    const auditLogs = logs as AuditLog[];

    // Calculate audit stats
    const actionCounts = auditLogs.reduce(
      (acc, log) => {
        const category = log.action.split("_")[0];
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const last24h = auditLogs.filter((log) => {
      const logDate = new Date(log.created_at);
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      return logDate > oneDayAgo;
    }).length;

    const uniqueUsers = new Set(auditLogs.map((log) => log.user_id)).size;

    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow-sm border border-border">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Total Actions</p>
              <p className="text-2xl font-bold text-foreground mt-1">
                {auditLogs.length}
              </p>
            </div>
            <div className="text-muted-foreground">
              <svg
                className="w-8 h-8"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>
          </div>
        </div>

        <div className="bg-primary/10 p-4 rounded-lg shadow-sm border border-primary/20">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-primary">Last 24 Hours</p>
              <p className="text-2xl font-bold text-primary mt-1">{last24h}</p>
            </div>
            <div className="text-primary/60">
              <svg
                className="w-8 h-8"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
        </div>

        <div className="bg-success/10 p-4 rounded-lg shadow-sm border border-success/30">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-success">Unique Users</p>
              <p className="text-2xl font-bold text-success mt-1">
                {uniqueUsers}
              </p>
            </div>
            <div className="text-success/60">
              <svg
                className="w-8 h-8"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            </div>
          </div>
        </div>

        <div className="bg-purple-50 p-4 rounded-lg shadow-sm border border-purple-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-purple-600">Top Action</p>
              <p className="text-lg font-bold text-purple-900 mt-1">
                {Object.entries(actionCounts).length > 0
                  ? Object.entries(actionCounts).sort(
                      ([, a], [, b]) => b - a,
                    )[0][0]
                  : "N/A"}
              </p>
            </div>
            <div className="text-purple-400">
              <svg
                className="w-8 h-8"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                />
              </svg>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // System logs stats
  const systemLogs = logs as SystemLog[];

  const levelCounts = systemLogs.reduce(
    (acc, log) => {
      acc[log.level] = (acc[log.level] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const errorCount = levelCounts.ERROR || 0;
  const warnCount = levelCounts.WARN || 0;
  const infoCount = levelCounts.INFO || 0;
  const debugCount = levelCounts.DEBUG || 0;

  const recentErrors = systemLogs.filter((log) => {
    if (log.level !== "ERROR") return false;
    const logDate = new Date(log.timestamp);
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);
    return logDate > oneHourAgo;
  }).length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      <div className="bg-destructive/10 p-4 rounded-lg shadow-sm border border-destructive/30">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-destructive">Errors</p>
            <p className="text-2xl font-bold text-destructive mt-1">{errorCount}</p>
            {recentErrors > 0 && (
              <p className="text-xs text-destructive mt-1">
                {recentErrors} in last hour
              </p>
            )}
          </div>
          <div className="text-destructive/60">
            <svg
              className="w-8 h-8"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
        </div>
      </div>

      <div className="bg-warning/10 p-4 rounded-lg shadow-sm border border-warning/30">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-warning">Warnings</p>
            <p className="text-2xl font-bold text-warning mt-1">
              {warnCount}
            </p>
          </div>
          <div className="text-yellow-400">
            <svg
              className="w-8 h-8"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
        </div>
      </div>

      <div className="bg-primary/10 p-4 rounded-lg shadow-sm border border-primary/20">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-primary">Info</p>
            <p className="text-2xl font-bold text-primary mt-1">{infoCount}</p>
          </div>
          <div className="text-primary/60">
            <svg
              className="w-8 h-8"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
        </div>
      </div>

      <div className="bg-muted p-4 rounded-lg shadow-sm border border-input">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Debug</p>
            <p className="text-2xl font-bold text-foreground mt-1">
              {debugCount}
            </p>
          </div>
          <div className="text-muted-foreground">
            <svg
              className="w-8 h-8"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
          </div>
        </div>
      </div>

      <div className="bg-white p-4 rounded-lg shadow-sm border border-border">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Total Logs</p>
            <p className="text-2xl font-bold text-foreground mt-1">
              {systemLogs.length}
            </p>
          </div>
          <div className="text-muted-foreground">
            <svg
              className="w-8 h-8"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
