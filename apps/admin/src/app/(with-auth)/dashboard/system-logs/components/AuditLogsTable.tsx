// src/app/(with-auth)/dashboard/system-logs/components/AuditLogsTable.tsx
"use client";

import type { ExtendedAuditLog } from "@/lib/types";
import { useState } from "react";
import { LogDetailsModal } from "./LogDetailsModal";

interface AuditLogsTableProps {
  logs: ExtendedAuditLog[];
  loading?: boolean;
}

export function AuditLogsTable({ logs, loading }: AuditLogsTableProps) {
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [selectedLog, setSelectedLog] = useState<ExtendedAuditLog | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const getActionColor = (action: string) => {
    if (action.includes("CREATE") || action.includes("ADD"))
      return "text-success";
    if (action.includes("UPDATE") || action.includes("EDIT"))
      return "text-primary";
    if (action.includes("DELETE") || action.includes("REMOVE"))
      return "text-destructive";
    if (action.includes("LOGIN") || action.includes("LOGOUT"))
      return "text-purple-600";
    return "text-muted-foreground";
  };

  const formatDetails = (details: string) => {
    try {
      const parsed = JSON.parse(details);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return details;
    }
  };

  if (loading && logs.length === 0) {
    return (
      <div className="bg-white shadow rounded-lg p-8">
        <div className="flex justify-center items-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="bg-white shadow rounded-lg p-8">
        <div className="text-center text-muted-foreground">
          No audit logs found for the selected filters.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-muted">
            <tr>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                Timestamp
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                User
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                Action
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                Details
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                IP Address
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-border">
            {logs.map((log) => (
              <tr key={log.id} className="hover:bg-muted">
                <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                  <div>
                    {new Date(log.created_at).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(log.created_at).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-foreground">
                    User #{log.user_id}
                  </div>
                  {log.user_name && (
                    <div className="text-sm text-muted-foreground">{log.user_name}</div>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`font-mono text-sm font-medium ${getActionColor(log.action)}`}
                  >
                    {log.action}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-foreground">
                  <div className="max-w-xs">
                    {log.details.length > 100 ? (
                      <>
                        <div className="truncate">{log.details}</div>
                        <button
                          onClick={() =>
                            setExpandedRow(
                              expandedRow === log.id ? null : log.id,
                            )
                          }
                          className="text-primary hover:text-primary text-xs mt-1"
                        >
                          {expandedRow === log.id ? "Show less" : "Show more"}
                        </button>
                        {expandedRow === log.id && (
                          <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto">
                            {formatDetails(log.details)}
                          </pre>
                        )}
                      </>
                    ) : (
                      <div>{log.details}</div>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                  {log.ip_address || "N/A"}
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

      {/* Log Details Modal */}
      <LogDetailsModal
        log={selectedLog}
        type="audit"
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedLog(null);
        }}
      />
    </div>
  );
}
