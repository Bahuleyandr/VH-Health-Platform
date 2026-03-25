// src/app/(with-auth)/dashboard/system-logs/components/LogMonitor.tsx
"use client";

import { useState, useEffect } from "react";
import { AuditLog, SystemLog } from "@/lib/types";
import { BellIcon } from "@/components/icons";

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
    <div className="fixed bottom-4 right-4 bg-primary text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-pulse">
      <BellIcon className="w-5 h-5" />
      <span className="font-medium">
        {newLogsCount} new {type} {newLogsCount === 1 ? "log" : "logs"}
      </span>
      <button
        onClick={() => setNewLogsCount(0)}
        className="ml-2 text-xs hover:text-muted-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}
