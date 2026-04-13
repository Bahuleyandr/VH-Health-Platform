// src/app/(with-auth)/dashboard/admin-management/components/PermissionsMatrix.tsx
//
// Orchestration-only: owns visibility toggles, audit-log fetch state, and
// which admin is being edited. UI is delegated to three sub-components
// (PermissionGrid, PermissionEditModal, PermissionAuditLog) and the
// configuration lives in permissionsConfig.ts.
"use client";

import { useCallback, useState } from "react";
import { getJSON } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import { PermissionGrid } from "./PermissionGrid";
import { PermissionEditModal } from "./PermissionEditModal";
import { PermissionAuditLog } from "./PermissionAuditLog";
import {
  PERMISSION_DISPLAY,
  type AuditEntry,
} from "./permissionsConfig";

interface PermissionsMatrixProps {
  admins: AdminUser[];
}

export function PermissionsMatrix({ admins }: PermissionsMatrixProps) {
  const [showMatrix, setShowMatrix] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<AdminUser | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);

  const fetchAuditLog = useCallback(async () => {
    setLoadingAudit(true);
    setShowAudit(true);
    try {
      const data = await getJSON<{
        entries?: AuditEntry[];
        logs?: AuditEntry[];
      }>("/api/v1/rbac/admin/audit-log?limit=20");
      setAuditEntries(data?.entries ?? data?.logs ?? []);
    } catch {
      setAuditEntries([]);
    } finally {
      setLoadingAudit(false);
    }
  }, []);

  if (!showMatrix) {
    return (
      <div className="mt-6">
        <button
          onClick={() => setShowMatrix(true)}
          className="text-primary hover:text-primary font-medium text-sm"
        >
          Show Permissions Matrix →
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">
          Permissions Matrix
        </h3>
        <div className="flex gap-3">
          <button
            onClick={fetchAuditLog}
            className="text-sm text-purple-600 hover:text-purple-800 font-medium"
          >
            View Audit Log
          </button>
          <button
            onClick={() => setShowMatrix(false)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Hide Matrix
          </button>
        </div>
      </div>

      <PermissionGrid admins={admins} onEdit={setEditingAdmin} />

      {editingAdmin && (
        <PermissionEditModal
          admin={editingAdmin}
          onClose={() => setEditingAdmin(null)}
          onSaved={() => window.location.reload()}
        />
      )}

      {showAudit && (
        <PermissionAuditLog
          entries={auditEntries}
          loading={loadingAudit}
          onClose={() => setShowAudit(false)}
        />
      )}

      <div className="text-sm text-muted-foreground">
        <p className="mb-2 font-medium">Permission Legend:</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {Object.entries(PERMISSION_DISPLAY).map(([key, label]) => (
            <div key={key} className="text-xs">
              <span className="font-medium">{label}:</span> {key}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
