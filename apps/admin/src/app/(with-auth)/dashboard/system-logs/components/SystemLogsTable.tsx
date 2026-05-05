// src/app/(with-auth)/dashboard/system-logs/components/SystemLogsTable.tsx
"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { ExtendedSystemLog } from "@/lib/types";
import { LogDetailsModal } from "./LogDetailsModal";
import { AlertCircle, AlertTriangle, Info, Code2 } from "lucide-react";

const levelColorMap: Record<string, string> = {
  ERROR: "bg-destructive/10 text-destructive border-destructive/50",
  WARN: "bg-warning/10 text-warning border-warning/50",
  INFO: "bg-primary/10 text-primary border-primary/30",
  DEBUG: "bg-muted text-foreground border-input",
};

const levelIconMap: Record<string, ReactNode> = {
  ERROR: <AlertCircle className="w-4 h-4" />,
  WARN: <AlertTriangle className="w-4 h-4" />,
  INFO: <Info className="w-4 h-4" />,
  DEBUG: <Code2 className="w-4 h-4" />,
};

interface SystemLogsTableProps {
  logs: ExtendedSystemLog[];
  loading?: boolean;
}

export function SystemLogsTable({ logs, loading }: SystemLogsTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [selectedLog, setSelectedLog] = useState<ExtendedSystemLog | null>(
    null,
  );
  const [isModalOpen, setIsModalOpen] = useState(false);

  const toggleRow = (id: number) => {
    const next = new Set(expandedRows);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedRows(next);
  };

  const formatStackTrace = (message: string): ReactNode => {
    if (message.includes("\n") || message.includes("  at ")) {
      return message.split("\n").map((line, i) => (
        <div key={i} className={line.trim().startsWith("at ") ? "ml-4" : ""}>
          {line}
        </div>
      ));
    }
    return message;
  };

  if (loading && logs.length === 0) {
    return (
      <div className="bg-white shadow rounded-lg p-8">
        <div className="flex justify-center items-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="bg-white shadow rounded-lg p-8">
        <div className="text-center text-muted-foreground">
          No system logs found for the selected filters.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] divide-y divide-border">
          <thead className="bg-muted">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Timestamp
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Level
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Service
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Message
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-border">
            {logs.map((log) => (
              <tr
                key={log.id}
                className={`hover:bg-muted ${log.level === "ERROR" ? "bg-destructive/10" : ""}`}
              >
                <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                  <div>
                    {new Date(log.timestamp).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(log.timestamp).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full border ${levelColorMap[log.level]}`}
                  >
                    {levelIconMap[log.level]}
                    {log.level}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-foreground">
                    {log.service || "API"}
                  </div>
                  {log.module ? (
                    <div className="text-xs text-muted-foreground">
                      {log.module}
                    </div>
                  ) : null}
                </td>
                <td className="px-6 py-4 text-sm">
                  <div className="max-w-2xl">
                    {log.message.length > 150 || log.message.includes("\n") ? (
                      <>
                        <div
                          className={`font-mono text-foreground ${expandedRows.has(log.id) ? "" : "truncate"}`}
                        >
                          {expandedRows.has(log.id)
                            ? formatStackTrace(log.message)
                            : log.message}
                        </div>
                        <button
                          onClick={() => toggleRow(log.id)}
                          className="text-primary hover:text-primary text-xs mt-1"
                        >
                          {expandedRows.has(log.id) ? "Show less" : "Show more"}
                        </button>
                      </>
                    ) : (
                      <div className="font-mono text-foreground">
                        {log.message}
                      </div>
                    )}
                    {log.metadata ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        <details>
                          <summary className="cursor-pointer hover:text-foreground">
                            Metadata
                          </summary>
                          <pre className="mt-1 p-2 bg-muted rounded overflow-x-auto">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        </details>
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  <button
                    onClick={() => {
                      setSelectedLog(log);
                      setIsModalOpen(true);
                    }}
                    className="text-primary hover:text-primary"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LogDetailsModal
        log={selectedLog}
        type="system"
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedLog(null);
        }}
      />
    </div>
  );
}
