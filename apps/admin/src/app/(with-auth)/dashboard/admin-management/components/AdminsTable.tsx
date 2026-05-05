// src/app/(with-auth)/dashboard/admin-management/components/AdminsTable.tsx
"use client";

import Link from "next/link";
import { useState, useMemo } from "react";
import type { AdminUser } from "@/lib/types";
import { putJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import { usePermissions } from "@/hooks/usePermissions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ClientTablePagination,
  compareTableValues,
  ManagedTableToolbar,
  paginateRows,
  SortableTableHeader,
  type SortDirection,
  type SortValue,
} from "@/components/table/client";

interface AdminsTableProps {
  admins: AdminUser[];
  onAdminUpdated?: () => void;
  isLoading?: boolean;
  error?: string | null;
}

type ToggleAction = "deactivate" | "reactivate";
type AdminSortKey = "name" | "role" | "permissions" | "status" | "last_login";

export function AdminsTable({
  admins,
  onAdminUpdated,
  isLoading,
  error,
}: AdminsTableProps) {
  const [updatingAdminId, setUpdatingAdminId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAdmin, setPendingAdmin] = useState<AdminUser | null>(null);
  const [pendingAction, setPendingAction] = useState<ToggleAction | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<AdminSortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

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

    setUpdatingAdminId(pendingAdmin.uid);

    try {
      const body =
        pendingAction === "deactivate"
          ? {
              action: pendingAction,
              adminId: pendingAdmin.uid,
              reason: "Deactivated via admin portal",
            }
          : { action: pendingAction, adminId: pendingAdmin.uid };

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
      return {
        text: "Invalid date",
        className: "text-muted-foreground",
        fullDate: "",
      };

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

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (admins ?? []).filter((admin) => {
      if (!query) return true;
      return [
        admin.name,
        admin.email,
        admin.role,
        getPermissionsSummary(admin.permissions),
        admin.is_active ? "active" : "inactive",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    filtered.sort((a, b) => {
      const result = compareTableValues(
        getAdminSortValue(a, sortKey),
        getAdminSortValue(b, sortKey),
      );
      return sortDirection === "asc" ? result : -result;
    });
    return filtered;
  }, [admins, search, sortDirection, sortKey]);

  const paged = paginateRows(rows, page, pageSize);

  const handleSort = (key: AdminSortKey) => {
    setSortDirection((current) =>
      sortKey === key && current === "asc" ? "desc" : "asc",
    );
    setSortKey(key);
    setPage(1);
  };

  const handlePageSizeChange = (value: number) => {
    setPageSize(value);
    setPage(1);
  };

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Loading administrators...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-destructive">
        {error}{" "}
        <button onClick={() => onAdminUpdated?.()} className="ml-2 underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <ManagedTableToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        placeholder="Search administrators by name, email, role, permission..."
        countLabel={`${rows.length} of ${admins.length} administrators`}
      />

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[980px] w-full divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <SortableTableHeader
                  label="Administrator"
                  sortKey="name"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Role"
                  sortKey="role"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Permissions"
                  sortKey="permissions"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Status"
                  sortKey="status"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Last Login"
                  sortKey="last_login"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody className="bg-white divide-y divide-border">
              {paged.rows.map((admin) => {
                const loginInfo = formatLastLogin(admin.last_login ?? null);
                const toggling = updatingAdminId === admin.uid;
                const toggleAllowed = canToggleFor(admin.is_active);

                return (
                  <tr key={admin.uid} className="hover:bg-muted">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {admin.name}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {admin.email}
                        </div>
                      </div>
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-foreground">
                        {admin.role}
                      </div>
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
                            href={`/dashboard/admin-management/edit-permissions/${admin.uid}`}
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
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    No administrators match the current search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ClientTablePagination
        page={paged.page}
        pageSize={pageSize}
        total={rows.length}
        onPageChange={setPage}
        onPageSizeChange={handlePageSizeChange}
        itemLabel="administrators"
      />

      <ConfirmDialog
        open={confirmOpen}
        setOpen={setConfirmOpen}
        title={
          pendingAction === "deactivate"
            ? "Deactivate Admin"
            : "Reactivate Admin"
        }
        message={
          pendingAction === "deactivate"
            ? `${pendingAdmin?.name ?? "This admin"} will lose all access immediately.`
            : `${pendingAdmin?.name ?? "This admin"} will regain access to the system.`
        }
        confirmLabel={
          pendingAction === "deactivate" ? "Deactivate" : "Reactivate"
        }
        variant={pendingAction === "deactivate" ? "destructive" : "default"}
        onConfirm={handleConfirmToggle}
      />
    </>
  );
}

function getAdminSortValue(admin: AdminUser, key: AdminSortKey): SortValue {
  switch (key) {
    case "role":
      return admin.role;
    case "permissions":
      return admin.permissions?.length ?? 0;
    case "status":
      return admin.is_active;
    case "last_login":
      return admin.last_login ? Date.parse(admin.last_login) : 0;
    case "name":
    default:
      return admin.name;
  }
}
