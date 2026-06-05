// src/app/(with-auth)/dashboard/departments/components/DepartmentsTable.tsx
"use client";

import { Department } from "@/lib/types";
import { useMemo, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { EditDepartmentModal } from "./EditDepartmentModal";
import { HospitalIcon } from "@/components/icons";
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

interface DepartmentsTableProps {
  departments: Department[];
  onDepartmentUpdated: () => void;
  onDepartmentDeleted: () => void;
  isLoading?: boolean;
  error?: string | null;
}

type DepartmentSortKey = "name" | "description" | "created_at";

export function DepartmentsTable({
  departments,
  onDepartmentUpdated,
  onDepartmentDeleted,
  isLoading,
  error,
}: DepartmentsTableProps) {
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDepartment, setPendingDepartment] = useState<Department | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<DepartmentSortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = departments.filter((department) => {
      if (!query) return true;
      return [department.name, department.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    filtered.sort((a, b) => {
      const result = compareTableValues(
        getDepartmentSortValue(a, sortKey),
        getDepartmentSortValue(b, sortKey),
      );
      return sortDirection === "asc" ? result : -result;
    });
    return filtered;
  }, [departments, search, sortDirection, sortKey]);

  const paged = paginateRows(rows, page, pageSize);

  const handleSort = (key: DepartmentSortKey) => {
    setSortDirection((current) =>
      sortKey === key && current === "asc" ? "desc" : "asc",
    );
    setSortKey(key);
    setPage(1);
  };

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Loading departments...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-destructive">
        {error}{" "}
        <button onClick={onDepartmentUpdated} className="ml-2 underline">
          Retry
        </button>
      </div>
    );
  }

  const handleDeleteClick = (department: Department) => {
    setPendingDepartment(department);
    setConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDepartment) return;

    try {
      setDeletingId(pendingDepartment.id);
      await fetchAdminAPI(`/departments/${pendingDepartment.id}`, {
        method: "DELETE",
      });
      onDepartmentDeleted();
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Failed to delete department",
      );
    } finally {
      setDeletingId(null);
      setPendingDepartment(null);
    }
  };

  if (departments.length === 0) {
    return (
      <div className="bg-card dark:bg-card p-8 rounded-lg shadow text-center">
        <HospitalIcon className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-2 text-sm font-medium text-foreground dark:text-white">
          No departments found
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Get started by creating a new department.
        </p>
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
        placeholder="Search departments by name or description..."
        countLabel={`${rows.length} of ${departments.length} departments`}
      />

      <div className="bg-card dark:bg-card shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] divide-y divide-border dark:divide-border">
            <thead className="bg-muted dark:bg-background">
              <tr>
                <SortableTableHeader
                  label="Department Name"
                  sortKey="name"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Description"
                  sortKey="description"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <SortableTableHeader
                  label="Created At"
                  sortKey="created_at"
                  activeSort={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-card divide-y divide-border">
              {paged.rows.map((department) => (
                <tr key={department.id} className="hover:bg-muted">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-foreground">
                      {department.name}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-muted-foreground">
                      {department.description || "No description provided"}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-muted-foreground">
                      {department.created_at
                        ? new Date(department.created_at).toLocaleDateString()
                        : "N/A"}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => setEditingDepartment(department)}
                      className="text-indigo-600 hover:text-indigo-900 mr-4"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteClick(department)}
                      disabled={deletingId === department.id}
                      className="text-destructive hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {deletingId === department.id ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    No departments match the current search.
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
        onPageSizeChange={(value) => {
          setPageSize(value);
          setPage(1);
        }}
        itemLabel="departments"
      />

      {editingDepartment && (
        <EditDepartmentModal
          department={editingDepartment}
          onClose={() => setEditingDepartment(null)}
          onSuccess={async () => {
            // Wait for the parent's refetch to land BEFORE closing the modal
            // so the table doesn't briefly flash stale data, and so the
            // user sees the new description on the row immediately.
            await Promise.resolve(onDepartmentUpdated());
            setEditingDepartment(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmOpen}
        setOpen={setConfirmOpen}
        title="Delete Department"
        message={
          pendingDepartment
            ? `This will permanently delete "${pendingDepartment.name}" and cannot be undone.`
            : "This will permanently delete this department and cannot be undone."
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}

function getDepartmentSortValue(
  department: Department,
  key: DepartmentSortKey,
): SortValue {
  switch (key) {
    case "description":
      return department.description;
    case "created_at":
      return department.created_at ? Date.parse(department.created_at) : 0;
    case "name":
    default:
      return department.name;
  }
}
