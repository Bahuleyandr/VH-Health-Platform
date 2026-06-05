// src/app/(with-auth)/dashboard/system-logs/components/LogStats.tsx
"use client";

import { AuditLog, SystemLog } from "@/lib/types";
import {
  ClipboardList,
  Clock,
  Users,
  TrendingUp,
  AlertCircle,
  AlertTriangle,
  Info,
  Code2,
  FileText,
} from "lucide-react";

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
        <div className="bg-card p-4 rounded-lg shadow-sm border border-border">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Total Actions
              </p>
              <p className="text-2xl font-bold text-foreground mt-1">
                {auditLogs.length}
              </p>
            </div>
            <div className="text-muted-foreground">
              <ClipboardList className="w-8 h-8" />
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
              <Clock className="w-8 h-8" />
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
              <Users className="w-8 h-8" />
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
              <TrendingUp className="w-8 h-8" />
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
            <p className="text-2xl font-bold text-destructive mt-1">
              {errorCount}
            </p>
            {recentErrors > 0 && (
              <p className="text-xs text-destructive mt-1">
                {recentErrors} in last hour
              </p>
            )}
          </div>
          <div className="text-destructive/60">
            <AlertCircle className="w-8 h-8" />
          </div>
        </div>
      </div>

      <div className="bg-warning/10 p-4 rounded-lg shadow-sm border border-warning/30">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-warning">Warnings</p>
            <p className="text-2xl font-bold text-warning mt-1">{warnCount}</p>
          </div>
          <div className="text-yellow-400">
            <AlertTriangle className="w-8 h-8" />
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
            <Info className="w-8 h-8" />
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
            <Code2 className="w-8 h-8" />
          </div>
        </div>
      </div>

      <div className="bg-card p-4 rounded-lg shadow-sm border border-border">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Total Logs
            </p>
            <p className="text-2xl font-bold text-foreground mt-1">
              {systemLogs.length}
            </p>
          </div>
          <div className="text-muted-foreground">
            <FileText className="w-8 h-8" />
          </div>
        </div>
      </div>
    </div>
  );
}
