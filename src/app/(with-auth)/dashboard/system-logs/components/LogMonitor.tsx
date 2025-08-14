// src/app/(with-auth)/dashboard/system-logs/components/LogMonitor.tsx
"use client";

import { useState, useEffect } from "react";
import { AuditLog, SystemLog } from "@/lib/types";

interface LogMonitorProps {
  logs: AuditLog[] | SystemLog[];
  type: "audit" | "system";
  isActive: boolean;
}

export function LogMonitor({ logs, type, isActive }: LogMonitorProps) {
  const [newLogsCount, setNewLogsCount] = useState(0);
  const [lastLogId, setLastLogId] = useState<number | null>(null);

  useEffect(() => {
    if (logs.length > 0) {
      const latestLogId = Math.max(...logs.map((log) => log.id));

      if (lastLogId !== null && latestLogId > lastLogId) {
        // Calculate new logs
        const newLogs = logs.filter((log) => log.id > lastLogId);
        setNewLogsCount((prev) => prev + newLogs.length);
      }

      setLastLogId(latestLogId);
    }
  }, [logs, lastLogId]);

  if (!isActive || newLogsCount === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-pulse">
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
          d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
        />
      </svg>
      <span className="font-medium">
        {newLogsCount} new {type} {newLogsCount === 1 ? "log" : "logs"}
      </span>
      <button
        onClick={() => setNewLogsCount(0)}
        className="ml-2 text-xs hover:text-gray-200"
      >
        Dismiss
      </button>
    </div>
  );
}
