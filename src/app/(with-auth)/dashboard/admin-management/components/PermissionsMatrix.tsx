// src/app/(with-auth)/dashboard/admin-management/components/PermissionsMatrix.tsx
"use client";

import { useState, useMemo, useCallback } from "react";
import { putJSON, getJSON } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import { toast } from "react-hot-toast";

/* ─── Permission categories ─── */
const PERMISSION_CATEGORIES: Record<string, { label: string; permissions: string[] }> = {
  users: {
    label: "User Management",
    permissions: ["userManagement"],
  },
  doctors: {
    label: "Doctor Management",
    permissions: ["doctorManagement"],
  },
  departments: {
    label: "Department Management",
    permissions: ["departmentManagement"],
  },
  appointments: {
    label: "Appointments",
    permissions: ["appointmentManagement"],
  },
  pharmacy: {
    label: "Pharmacy",
    permissions: ["pharmacyAdminRoutes"],
  },
  notifications: {
    label: "Notifications",
    permissions: ["notificationManagement"],
  },
  admin: {
    label: "Admin & Audit",
    permissions: ["adminManagement", "viewAuditLogs"],
  },
};

const ALL_PERMISSIONS = Object.values(PERMISSION_CATEGORIES).flatMap((c) => c.permissions);

const PERMISSION_DISPLAY: Record<string, string> = {
  adminManagement: "Admin Mgmt",
  userManagement: "User Mgmt",
  doctorManagement: "Doctor Mgmt",
  departmentManagement: "Dept Mgmt",
  appointmentManagement: "Appt Mgmt",
  pharmacyAdminRoutes: "Pharmacy",
  notificationManagement: "Notifications",
  viewAuditLogs: "Audit Logs",
};

/* ─── Role templates ─── */
interface RoleTemplate {
  label: string;
  permissions: string[];
}

const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  superAdmin: {
    label: "Super Admin",
    permissions: [...ALL_PERMISSIONS],
  },
  departmentHead: {
    label: "Department Head",
    permissions: ["doctorManagement", "departmentManagement", "appointmentManagement", "notificationManagement"],
  },
  receptionist: {
    label: "Receptionist",
    permissions: ["appointmentManagement", "userManagement"],
  },
  pharmacist: {
    label: "Pharmacist",
    permissions: ["pharmacyAdminRoutes"],
  },
  hrManager: {
    label: "HR Manager",
    permissions: ["userManagement", "departmentManagement", "viewAuditLogs"],
  },
};

/* ─── Audit log entry ─── */
interface AuditEntry {
  timestamp: string;
  action: string;
  adminName: string;
  details?: string;
}

interface PermissionsMatrixProps {
  admins: AdminUser[];
}

export function PermissionsMatrix({ admins }: PermissionsMatrixProps) {
  const [showMatrix, setShowMatrix] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<AdminUser | null>(null);
  const [editPerms, setEditPerms] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);

  const startEdit = useCallback((admin: AdminUser) => {
    setEditingAdmin(admin);
    setEditPerms(Array.isArray(admin.permissions) ? [...admin.permissions] : []);
  }, []);

  const togglePerm = useCallback((perm: string) => {
    setEditPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  }, []);

  const selectAllCategory = useCallback((perms: string[]) => {
    setEditPerms((prev) => {
      const set = new Set(prev);
      perms.forEach((p) => set.add(p));
      return Array.from(set);
    });
  }, []);

  const clearCategory = useCallback((perms: string[]) => {
    setEditPerms((prev) => prev.filter((p) => !perms.includes(p)));
  }, []);

  const applyTemplate = useCallback((templateKey: string) => {
    const tmpl = ROLE_TEMPLATES[templateKey];
    if (tmpl) setEditPerms([...tmpl.permissions]);
  }, []);

  const savePermissions = useCallback(async () => {
    if (!editingAdmin) return;
    setSaving(true);
    try {
      await putJSON("/api/v1/auth/admin/update-permissions", {
        adminId: editingAdmin.id,
        permissions: editPerms,
      });
      toast.success(`Permissions updated for ${editingAdmin.name}`);
      setEditingAdmin(null);
      // Parent will refetch via invalidation
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save permissions");
    } finally {
      setSaving(false);
    }
  }, [editingAdmin, editPerms]);

  const fetchAuditLog = useCallback(async () => {
    setLoadingAudit(true);
    setShowAudit(true);
    try {
      const data = await getJSON<{ entries?: AuditEntry[]; logs?: AuditEntry[] }>(
        "/api/v1/rbac/admin/audit-log?limit=20",
      );
      setAuditLog(data?.entries ?? data?.logs ?? []);
    } catch {
      setAuditLog([]);
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
        <h3 className="text-lg font-medium text-foreground">Permissions Matrix</h3>
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

      {/* ─── Read-only matrix table ─── */}
      <div className="overflow-hidden rounded-lg bg-white shadow">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <th className="sticky left-0 z-10 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground bg-muted">
                  Admin
                </th>
                {ALL_PERMISSIONS.map((p) => (
                  <th key={p} className="px-3 py-3 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground" title={p}>
                    {PERMISSION_DISPLAY[p] ?? p}
                  </th>
                ))}
                <th className="px-3 py-3 text-center text-xs font-medium uppercase text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {admins.map((admin) => {
                const isSuperAdmin = admin.role === "SUPER_ADMIN";
                const perms = Array.isArray(admin.permissions) ? admin.permissions : [];
                return (
                  <tr key={admin.id} className="hover:bg-muted">
                    <td className="sticky left-0 z-10 whitespace-nowrap px-6 py-4 bg-white">
                      <div className="text-sm font-medium text-foreground">{admin.name}</div>
                      <div className="text-xs text-muted-foreground">{admin.role}</div>
                    </td>
                    {ALL_PERMISSIONS.map((perm) => {
                      const has = isSuperAdmin || perms.includes(perm);
                      return (
                        <td key={perm} className="whitespace-nowrap px-3 py-4 text-center">
                          <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${has ? "bg-success/10" : "bg-muted"}`}>
                            {has ? (
                              <svg className="h-4 w-4 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : (
                              <svg className="h-4 w-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            )}
                          </span>
                        </td>
                      );
                    })}
                    <td className="px-3 py-4 text-center">
                      {!isSuperAdmin && (
                        <button
                          onClick={() => startEdit(admin)}
                          className="text-sm text-primary hover:text-primary font-medium"
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Edit modal ─── */}
      {editingAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 m-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold">
                Edit Permissions — {editingAdmin.name}
              </h3>
              <button onClick={() => setEditingAdmin(null)} className="text-muted-foreground hover:text-muted-foreground text-xl">×</button>
            </div>

            {/* Role templates */}
            <div className="mb-5">
              <p className="text-sm font-medium text-foreground mb-2">Apply Role Template:</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(ROLE_TEMPLATES).map(([key, tmpl]) => (
                  <button
                    key={key}
                    onClick={() => applyTemplate(key)}
                    className="px-3 py-1.5 text-sm rounded-full border border-input hover:border-primary hover:text-primary bg-white transition-colors"
                  >
                    {tmpl.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Permission categories with toggles */}
            <div className="space-y-4">
              {Object.entries(PERMISSION_CATEGORIES).map(([catKey, cat]) => {
                const allSelected = cat.permissions.every((p) => editPerms.includes(p));
                return (
                  <div key={catKey} className="border border-border rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-medium text-foreground">{cat.label}</h4>
                      <div className="flex gap-2">
                        <button
                          onClick={() => selectAllCategory(cat.permissions)}
                          className="text-xs text-success hover:text-success"
                        >
                          Select All
                        </button>
                        <button
                          onClick={() => clearCategory(cat.permissions)}
                          className="text-xs text-destructive hover:text-destructive"
                        >
                          Clear All
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {cat.permissions.map((perm) => {
                        const enabled = editPerms.includes(perm);
                        return (
                          <div key={perm} className="flex items-center justify-between">
                            <span className="text-sm text-foreground">
                              {PERMISSION_DISPLAY[perm] ?? perm}
                            </span>
                            {/* Toggle switch */}
                            <button
                              type="button"
                              role="switch"
                              aria-checked={enabled}
                              onClick={() => togglePerm(perm)}
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                enabled ? "bg-primary" : "bg-muted"
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                  enabled ? "translate-x-6" : "translate-x-1"
                                }`}
                              />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Save / Cancel */}
            <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
              <button
                onClick={() => setEditingAdmin(null)}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground border border-input rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={savePermissions}
                disabled={saving}
                className="px-4 py-2 text-sm text-white bg-primary hover:bg-primary/90 rounded-md disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Permissions"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Audit Log ─── */}
      {showAudit && (
        <div className="bg-white rounded-lg shadow p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Permission Audit Log</h3>
            <button onClick={() => setShowAudit(false)} className="text-sm text-muted-foreground hover:text-foreground">
              Close
            </button>
          </div>
          {loadingAudit ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : auditLog.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4">No audit log entries found.</p>
          ) : (
            <div className="divide-y divide-border">
              {auditLog.map((entry, i) => (
                <div key={i} className="py-3 flex items-start gap-3">
                  <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-primary/60" />
                  <div>
                    <p className="text-sm text-foreground">
                      <span className="font-medium">{entry.adminName}</span> — {entry.action}
                    </p>
                    {entry.details && <p className="text-xs text-muted-foreground mt-0.5">{entry.details}</p>}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(entry.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Legend */}
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
