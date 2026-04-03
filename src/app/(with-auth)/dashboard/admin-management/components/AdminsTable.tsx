// src/app/(with-auth)/dashboard/admin-management/components/AdminsTable.tsx
"use client";

import Link from "next/link";
import { useState, useMemo } from "react";
import type { AdminUser } from "@/lib/types";
import { putJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import { usePermissions } from "@/hooks/usePermissions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface AdminsTableProps {
  admins: AdminUser[];
  onAdminUpdated?: () => void;
  isLoading?: boolean;
  error?: string | null;
}

type ToggleAction = "deactivate" | "reactivate";

export function AdminsTable({ admins, onAdminUpdated, isLoading, error }: AdminsTableProps) {
  const [updatingAdminId, setUpdatingAdminId] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAdmin, setPendingAdmin] = useState<AdminUser | null>(null);
  const [pendingAction, setPendingAction] = useState<ToggleAction | null>(null);

  // Optional permission gating (SUPER_ADMIN auto-passes)
  const { hasPermission, isSuperAdmin } = usePermissions();

  const canEditPermissions =
    isSuperAdmin || hasPermission("admin:permissions:update");

  const canToggleFor = (isActive: boolean) =>
    isSuperAdmin ||
    (isActive
      ? hasPermission("admin:deactivate")
      : hasPermission("admin:reactivate"));

  const handleToggleClick = (admin: AdminUser) => {
    if (!canToggleFor(admin.is_active)) return;
    const action: ToggleAction = admin.is_active ? "deactivate" : "reactivate";
    setPendingAdmin(admin);
    setPendingAction(action);
    setConfirmOpen(true);
  };

  const handleConfirmToggle = async () => {
    if (!pendingAdmin || !pendingAction) return;

    setUpdatingAdminId(pendingAdmin.id);

    try {
      const body =
        pendingAction === "deactivate"
          ? {
              action: pendingAction,
              adminId: pendingAdmin.id,
              reason: "Deactivated via admin portal",
            }
          : { action: pendingAction, adminId: pendingAdmin.id };

      await putJSON(API_ENDPOINTS.auth.adminManagement, body);

      onAdminUpdated?.();
    } catch (error) {
      console.error("Failed to toggle admin status:", error);
      alert("Failed to update admin status. Please try again.");
    } finally {
      setUpdatingAdminId(null);
      setPendingAdmin(null);
      setPendingAction(null);
    }
  };

  const formatLastLogin = (lastLogin: string | null) => {
    if (!lastLogin)
      return {
        text: "Never",
        className: "text-muted-foreground" as string,
        fullDate: "",
      };

    const t = Date.parse(lastLogin);
    if (Number.isNaN(t))
      return { text: "Invalid date", className: "text-muted-foreground", fullDate: "" };

    const date = new Date(t);
    const now = Date.now();
    const diffDays = Math.floor((now - t) / (1000 * 60 * 60 * 24));

    let text = date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    let className = "text-muted-foreground";

    if (diffDays === 0) {
      text = "Today";
      className = "text-success font-medium";
    } else if (diffDays === 1) {
      text = "Yesterday";
      className = "text-primary";
    } else if (diffDays <= 7) {
      text = `${diffDays} days ago`;
      className = "text-primary";
    } else if (diffDays > 30) {
      className = "text-orange-600";
    }

    return { text, className, fullDate: date.toLocaleString() };
  };

  const getPermissionsSummary = (permissions: string[]) => {
    if (!permissions?.length) return "No permissions";
    if (permissions.length <= 3) return permissions.join(", ");
    return `${permissions.slice(0, 3).join(", ")} +${permissions.length - 3} more`;
  };

  const rows = useMemo(() => admins ?? [], [admins]);

  if (isLoading) {
    return <div className="p-6 text-center text-muted-foreground">Loading administrators...</div>;
  }

  if (error) {
    return (
      <div className="p-6 text-center text-destructive">
        {error} <button onClick={() => onAdminUpdated?.()} className="ml-2 underline">Retry</button>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Administrator
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Permissions
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Last Login
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody className="bg-white divide-y divide-border">
              {rows.map((admin) => {
                const loginInfo = formatLastLogin(admin.last_login ?? null);
                const toggling = updatingAdminId === admin.id;
                const toggleAllowed = canToggleFor(admin.is_active);

                return (
                  <tr key={admin.id} className="hover:bg-muted">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {admin.name}
                        </div>
                        <div className="text-sm text-muted-foreground">{admin.email}</div>
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-foreground">{admin.role}</div>
                    </td>

                    <td className="px-6 py-4">
                      <div className="text-sm text-muted-foreground">
                        {getPermissionsSummary(admin.permissions)}
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          admin.is_active
                            ? "bg-success/10 text-success"
                            : "bg-destructive/10 text-destructive"
                        }`}
                      >
                        {admin.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`text-sm ${loginInfo.className}`}
                        title={loginInfo.fullDate}
                      >
                        {loginInfo.text}
                      </span>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="flex items-center gap-3">
                        {canEditPermissions ? (
                          <Link
                            href={`/dashboard/admin-management/edit-permissions/${admin.id}`}
                            className="text-primary hover:text-primary transition-colors"
                          >
                            Edit Permissions
                          </Link>
                        ) : (
                          <span className="text-muted-foreground cursor-not-allowed">
                            Edit Permissions
                          </span>
                        )}

                        <button
                          onClick={() => handleToggleClick(admin)}
                          disabled={toggling || !toggleAllowed}
                          className={`transition-colors ${
                            toggling || !toggleAllowed
                              ? "text-muted-foreground cursor-not-allowed"
                              : admin.is_active
                                ? "text-destructive hover:text-destructive"
                                : "text-success hover:text-success"
                          }`}
                          title={
                            toggleAllowed
                              ? admin.is_active
                                ? "Deactivate admin"
                                : "Reactivate admin"
                              : "You do not have permission for this action"
                          }
                        >
                          {toggling
                            ? "Updating..."
                            : admin.is_active
                              ? "Deactivate"
                              : "Reactivate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        setOpen={setConfirmOpen}
        title={pendingAction === "deactivate" ? "Deactivate Admin" : "Reactivate Admin"}
        message={
          pendingAction === "deactivate"
            ? `${pendingAdmin?.name ?? "This admin"} will lose all access immediately.`
            : `${pendingAdmin?.name ?? "This admin"} will regain access to the system.`
        }
        confirmLabel={pendingAction === "deactivate" ? "Deactivate" : "Reactivate"}
        variant={pendingAction === "deactivate" ? "destructive" : "default"}
        onConfirm={handleConfirmToggle}
      />
    </>
  );
}
