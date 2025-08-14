// src/app/(with-auth)/dashboard/system-logs/components/LogDetailsModal.tsx
"use client";

import { ExtendedAuditLog, ExtendedSystemLog } from "@/lib/types";

interface LogDetailsModalProps {
  log: ExtendedAuditLog | ExtendedSystemLog | null;
  type: "audit" | "system";
  isOpen: boolean;
  onClose: () => void;
}

export function LogDetailsModal({
  log,
  type,
  isOpen,
  onClose,
}: LogDetailsModalProps) {
  if (!isOpen || !log) return null;

  // Always return a string for React children
  const formatJSON = (data: unknown): string => {
    try {
      if (typeof data === "string") {
        return JSON.stringify(JSON.parse(data), null, 2);
      }
      return JSON.stringify(data, null, 2);
    } catch {
      return typeof data === "string" ? data : String(data);
    }
  };

  const isAuditLog = (
    log: ExtendedAuditLog | ExtendedSystemLog,
  ): log is ExtendedAuditLog => {
    return "created_at" in log && "user_id" in log && "action" in log;
  };

  const isSystemLog = (
    log: ExtendedAuditLog | ExtendedSystemLog,
  ): log is ExtendedSystemLog => {
    return "timestamp" in log && "level" in log && "message" in log;
  };

  return (
    <div
      className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50"
      onClick={onClose}
    >
      <div
        className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-gray-900">
            {type === "audit" ? "Audit Log Details" : "System Log Details"}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {type === "audit" && isAuditLog(log) ? (
            <>
              <div>
                <h4 className="text-sm font-medium text-gray-700">Timestamp</h4>
                <p className="mt-1 text-sm text-gray-900">
                  {new Date(log.created_at).toLocaleString("en-GB")}
                </p>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-700">User</h4>
                <p className="mt-1 text-sm text-gray-900">
                  ID: {log.user_id}
                  {log.user_name && ` (${log.user_name})`}
                </p>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-700">Action</h4>
                <p className="mt-1 text-sm font-mono text-gray-900">
                  {log.action}
                </p>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-700">Details</h4>
                <pre className="mt-1 p-3 bg-gray-100 rounded text-xs overflow-x-auto">
                  {formatJSON(log.details)}
                </pre>
              </div>

              {log.ip_address && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700">
                    IP Address
                  </h4>
                  <p className="mt-1 text-sm text-gray-900">{log.ip_address}</p>
                </div>
              )}
            </>
          ) : type === "system" && isSystemLog(log) ? (
            <>
              <div>
                <h4 className="text-sm font-medium text-gray-700">Timestamp</h4>
                <p className="mt-1 text-sm text-gray-900">
                  {new Date(log.timestamp).toLocaleString("en-GB")}
                </p>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-700">Level</h4>
                <p className="mt-1 text-sm">
                  <span
                    className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      log.level === "ERROR"
                        ? "bg-red-100 text-red-800"
                        : log.level === "WARN"
                          ? "bg-yellow-100 text-yellow-800"
                          : log.level === "INFO"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {log.level}
                  </span>
                </p>
              </div>

              {log.service && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700">Service</h4>
                  <p className="mt-1 text-sm text-gray-900">
                    {log.service}
                    {log.module && ` - ${log.module}`}
                  </p>
                </div>
              )}

              <div>
                <h4 className="text-sm font-medium text-gray-700">Message</h4>
                <pre className="mt-1 p-3 bg-gray-100 rounded text-xs overflow-x-auto whitespace-pre-wrap">
                  {log.message}
                </pre>
              </div>

              {log.metadata && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700">
                    Metadata
                  </h4>
                  <pre className="mt-1 p-3 bg-gray-100 rounded text-xs overflow-x-auto">
                    {formatJSON(log.metadata)}
                  </pre>
                </div>
              )}
            </>
          ) : null}

          <div>
            <h4 className="text-sm font-medium text-gray-700">Log ID</h4>
            <p className="mt-1 text-sm font-mono text-gray-900">{log.id}</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={() => {
              navigator.clipboard.writeText(JSON.stringify(log, null, 2));
              alert("Log details copied to clipboard!");
            }}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
          >
            Copy JSON
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
