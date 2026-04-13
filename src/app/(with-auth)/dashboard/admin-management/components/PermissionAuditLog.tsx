// Inline audit log panel showing the most recent permission changes.
// Parent owns the fetch state + visibility toggle; this widget just renders.
"use client";

import type { AuditEntry } from "./permissionsConfig";

interface PermissionAuditLogProps {
  entries: AuditEntry[];
  loading: boolean;
  onClose: () => void;
}

export function PermissionAuditLog({
  entries,
  loading,
  onClose,
}: PermissionAuditLogProps) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Permission Audit Log</h3>
        <button
          onClick={onClose}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>
      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground text-sm py-4">
          No audit log entries found.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {entries.map((entry, i) => (
            <div key={i} className="py-3 flex items-start gap-3">
              <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-primary/60" />
              <div>
                <p className="text-sm text-foreground">
                  <span className="font-medium">{entry.adminName}</span> —{" "}
                  {entry.action}
                </p>
                {entry.details && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {entry.details}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(entry.timestamp).toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
