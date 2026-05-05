// src/app/(with-auth)/dashboard/users/components/UsersTable.tsx
"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { User } from "@/lib/types";
import { useSelection } from "@/hooks/useSelection";
import { BulkActions } from "@/components/BulkActions";
import { fetchAdminAPI } from "@/lib/api";
import toast from "react-hot-toast";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle,
  Pencil,
  X,
  XCircle,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type SortKey =
  | "name"
  | "email"
  | "phone"
  | "role"
  | "department"
  | "status"
  | "registered_at";

type UserRecord = User & {
  uid?: string | null;
  role?: string | null;
  department?: string | null;
  specialization?: string | null;
  last_login?: string | null;
  status?: string | null;
};

interface UsersTableProps {
  users: UserRecord[];
  onUserUpdated: () => void;
  isLoading?: boolean;
  error?: string | null;
  sortBy?: string;
  sortOrder?: string;
}

type BulkConfirmAction = "delete" | "deactivate" | "activate";

interface EditFormState {
  name: string;
  email: string;
  is_active: boolean;
}

const STATUS = {
  active: "active",
  inactive: "inactive",
} as const;

function displayValue(value: unknown, fallback = "-") {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const str = String(value).trim();
  return str.length > 0 ? str : fallback;
}

function formatRole(role: string | null | undefined) {
  return role ? role.replaceAll("_", " ") : "USER";
}

export function UsersTable({
  users,
  onUserUpdated,
  isLoading,
  error,
  sortBy = "registered_at",
  sortOrder = "DESC",
}: UsersTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    selectedIds,
    selectedCount,
    toggleSelection,
    toggleAll,
    clearSelection,
    isSelected,
    isAllSelected,
    isPartiallySelected,
  } = useSelection(users);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingBulkAction, setPendingBulkAction] =
    useState<BulkConfirmAction | null>(null);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [editForm, setEditForm] = useState<EditFormState>({
    name: "",
    email: "",
    is_active: true,
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate =
        !!isPartiallySelected && !isAllSelected;
    }
  }, [isPartiallySelected, isAllSelected]);

  const handleSort = (key: SortKey) => {
    const params = new URLSearchParams(searchParams);
    const currentOrder = sortOrder.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const nextOrder = sortBy === key && currentOrder === "ASC" ? "DESC" : "ASC";

    params.set("sortBy", key);
    params.set("sortOrder", nextOrder);
    params.set("page", "1");
    router.push(`/dashboard/users?${params.toString()}`);
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortBy !== key) return <ArrowUpDown className="h-3.5 w-3.5" />;
    return sortOrder.toUpperCase() === "ASC" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  };

  const openEdit = (user: UserRecord) => {
    setEditingUser(user);
    setEditForm({
      name: user.name ?? "",
      email: user.email ?? "",
      is_active: Boolean(user.is_active),
    });
  };

  const closeEdit = () => {
    if (savingEdit) return;
    setEditingUser(null);
  };

  const updateUserStatus = async (
    id: string | number,
    isActive: boolean,
    reason: string,
  ) => {
    await fetchAdminAPI(`/users/${id}/status`, {
      method: "PUT",
      body: {
        status: isActive ? STATUS.active : STATUS.inactive,
        reason,
      },
    });
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingUser) return;

    const name = editForm.name.trim();
    const email = editForm.email.trim();
    if (name.length > 0 && name.length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }

    const profileBody: Record<string, string> = {};
    if (name && name !== (editingUser.name ?? "")) profileBody.name = name;
    if (email && email !== (editingUser.email ?? "")) profileBody.email = email;

    setSavingEdit(true);
    try {
      if (Object.keys(profileBody).length > 0) {
        await fetchAdminAPI(`/users/${editingUser.id}`, {
          method: "PUT",
          body: profileBody,
        });
      }

      if (Boolean(editingUser.is_active) !== editForm.is_active) {
        await updateUserStatus(
          editingUser.id,
          editForm.is_active,
          "Admin user edit",
        );
      }

      toast.success("User updated");
      setEditingUser(null);
      onUserUpdated();
      clearSelection();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update user");
    } finally {
      setSavingEdit(false);
    }
  };

  const confirmBulkAction = (action: BulkConfirmAction) => {
    setPendingBulkAction(action);
    setConfirmOpen(true);
  };

  const executeBulkAction = async () => {
    if (!pendingBulkAction) return;

    if (pendingBulkAction === "delete") {
      const promises = selectedIds.map((id) =>
        fetchAdminAPI(`/users/${id}`, {
          method: "DELETE",
          body: { reason: "Admin bulk deletion" },
        }),
      );
      await Promise.all(promises);
      toast.success(`Deleted ${selectedCount} users`);
    } else if (pendingBulkAction === "deactivate") {
      const promises = selectedIds.map((id) =>
        updateUserStatus(id, false, "Admin bulk deactivation"),
      );
      await Promise.all(promises);
      toast.success(`Deactivated ${selectedCount} users`);
    } else if (pendingBulkAction === "activate") {
      const promises = selectedIds.map((id) =>
        updateUserStatus(id, true, "Admin bulk activation"),
      );
      await Promise.all(promises);
      toast.success(`Activated ${selectedCount} users`);
    }

    onUserUpdated();
    clearSelection();
    setPendingBulkAction(null);
  };

  const handleBulkExport = () => {
    const selectedUsers = users.filter((user) => selectedIds.includes(user.id));
    const csv = convertToCSV(selectedUsers);
    downloadCSV(csv, "users-export.csv");
    toast.success(`Exported ${selectedCount} users`);
  };

  const getConfirmProps = (): {
    title: string;
    message: string;
    confirmLabel: string;
    variant: "destructive" | "default";
  } => {
    switch (pendingBulkAction) {
      case "delete":
        return {
          title: `Delete ${selectedCount} Users`,
          message: `Delete ${selectedCount} selected users? This will deactivate their access.`,
          confirmLabel: "Delete",
          variant: "destructive",
        };
      case "deactivate":
        return {
          title: `Deactivate ${selectedCount} Users`,
          message: `These ${selectedCount} users will lose access to the system.`,
          confirmLabel: "Deactivate",
          variant: "destructive",
        };
      case "activate":
        return {
          title: `Activate ${selectedCount} Users`,
          message: `These ${selectedCount} users will regain access to the system.`,
          confirmLabel: "Activate",
          variant: "default",
        };
      default:
        return {
          title: "Confirm Action",
          message: "Are you sure?",
          confirmLabel: "Confirm",
          variant: "default",
        };
    }
  };

  const confirmProps = getConfirmProps();

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Loading users...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-destructive">
        {error}{" "}
        <button onClick={onUserUpdated} className="ml-2 underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg bg-white shadow dark:bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] divide-y divide-border dark:divide-border">
            <thead className="bg-muted dark:bg-background">
              <tr>
                <th scope="col" className="w-14 px-6 py-3 text-left">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
                  />
                </th>
                <SortableHeader
                  label="Name"
                  sortKey="name"
                  onSort={handleSort}
                  icon={renderSortIcon("name")}
                />
                <SortableHeader
                  label="Email"
                  sortKey="email"
                  onSort={handleSort}
                  icon={renderSortIcon("email")}
                />
                <SortableHeader
                  label="Phone"
                  sortKey="phone"
                  onSort={handleSort}
                  icon={renderSortIcon("phone")}
                />
                <SortableHeader
                  label="Role"
                  sortKey="role"
                  onSort={handleSort}
                  icon={renderSortIcon("role")}
                />
                <SortableHeader
                  label="Department"
                  sortKey="department"
                  onSort={handleSort}
                  icon={renderSortIcon("department")}
                />
                <SortableHeader
                  label="Status"
                  sortKey="status"
                  onSort={handleSort}
                  icon={renderSortIcon("status")}
                />
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-white dark:divide-border dark:bg-card">
              {users.map((user) => (
                <tr
                  key={user.id}
                  className={`hover:bg-muted dark:hover:bg-muted ${
                    isSelected(user.id)
                      ? "bg-primary/10 dark:bg-primary/20"
                      : ""
                  }`}
                >
                  <td className="px-6 py-4">
                    <input
                      type="checkbox"
                      checked={isSelected(user.id)}
                      onChange={() => toggleSelection(user.id)}
                      className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
                    />
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-foreground dark:text-white">
                      {displayValue(user.name, "(unnamed)")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ID {user.id}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {displayValue(user.email)}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {displayValue(user.phone)}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {formatRole(user.role)}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {displayValue(user.department ?? user.specialization)}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                        user.is_active
                          ? "bg-success/10 text-success dark:bg-success/20 dark:text-success/70"
                          : "bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive/60"
                      }`}
                    >
                      {user.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right text-sm font-medium">
                    <button
                      type="button"
                      onClick={() => openEdit(user)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-primary hover:bg-primary/10"
                    >
                      <Pencil className="h-4 w-4" />
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    No users found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <BulkActions
        selectedCount={selectedCount}
        onDelete={async () => {
          confirmBulkAction("delete");
        }}
        onExport={handleBulkExport}
        onClearSelection={clearSelection}
        actions={[
          {
            label: "Activate",
            onClick: () => confirmBulkAction("activate"),
            variant: "primary",
            icon: <CheckCircle className="mr-2 h-4 w-4" />,
          },
          {
            label: "Deactivate",
            onClick: () => confirmBulkAction("deactivate"),
            variant: "default",
            icon: <XCircle className="mr-2 h-4 w-4" />,
          },
        ]}
      />

      <ConfirmDialog
        open={confirmOpen}
        setOpen={setConfirmOpen}
        title={confirmProps.title}
        message={confirmProps.message}
        confirmLabel={confirmProps.confirmLabel}
        variant={confirmProps.variant}
        onConfirm={executeBulkAction}
      />

      {editingUser && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-user-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <button
            type="button"
            aria-label="Close edit user dialog"
            className="absolute inset-0 bg-black/50"
            onClick={closeEdit}
          />
          <form
            onSubmit={saveEdit}
            className="relative z-10 w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-lg"
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2
                  id="edit-user-title"
                  className="text-lg font-semibold text-foreground"
                >
                  Edit User
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatRole(editingUser.role)} account
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={closeEdit}
                className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-4">
              <label className="grid gap-1 text-sm font-medium text-foreground">
                Name
                <input
                  value={editForm.name}
                  onChange={(event) =>
                    setEditForm((prev) => ({
                      ...prev,
                      name: event.target.value,
                    }))
                  }
                  minLength={2}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                />
              </label>

              <label className="grid gap-1 text-sm font-medium text-foreground">
                Email
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(event) =>
                    setEditForm((prev) => ({
                      ...prev,
                      email: event.target.value,
                    }))
                  }
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium text-foreground">
                  Phone
                  <input
                    value={displayValue(editingUser.phone)}
                    readOnly
                    className="rounded-md border border-input bg-muted px-3 py-2 text-sm font-normal text-muted-foreground"
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium text-foreground">
                  Role
                  <input
                    value={formatRole(editingUser.role)}
                    readOnly
                    className="rounded-md border border-input bg-muted px-3 py-2 text-sm font-normal text-muted-foreground"
                  />
                </label>
              </div>

              <label className="flex items-center gap-3 rounded-md border border-border p-3 text-sm font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={editForm.is_active}
                  onChange={(event) =>
                    setEditForm((prev) => ({
                      ...prev,
                      is_active: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
                />
                Active account
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeEdit}
                disabled={savingEdit}
                className="rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {savingEdit ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function SortableHeader({
  label,
  sortKey,
  onSort,
  icon,
}: {
  label: string;
  sortKey: SortKey;
  onSort: (key: SortKey) => void;
  icon: ReactNode;
}) {
  return (
    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {icon}
      </button>
    </th>
  );
}

function convertToCSV(users: UserRecord[]): string {
  const headers = [
    "ID",
    "Name",
    "Email",
    "Phone",
    "Role",
    "Department",
    "Status",
    "Created At",
  ];
  const rows = users.map((user) => [
    user.id,
    user.name,
    user.email,
    user.phone,
    user.role,
    user.department,
    user.is_active ? "Active" : "Inactive",
    new Date(user.created_at).toLocaleDateString(),
  ]);

  return [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
