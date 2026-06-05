// Read-only table view of every admin's permissions. Per-row "Edit" button
// invokes the passed callback so the parent can mount the edit modal.
"use client";

import { useMemo, useState } from "react";
import { CheckIcon, CloseIcon } from "@/components/icons";
import {
  ClientTablePagination,
  compareTableValues,
  ManagedTableToolbar,
  paginateRows,
  SortableTableHeader,
  type SortDirection,
} from "@/components/table/client";
import type { AdminUser } from "@/lib/types";
import { ALL_PERMISSIONS, PERMISSION_DISPLAY } from "./permissionsConfig";

interface PermissionGridProps {
  admins: AdminUser[];
  onEdit: (admin: AdminUser) => void;
}

export function PermissionGrid({ admins, onEdit }: PermissionGridProps) {
  const [search, setSearch] = useState("");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = admins.filter((admin) => {
      if (!query) return true;
      const permissions = Array.isArray(admin.permissions)
        ? admin.permissions
        : [];
      return [
        admin.name,
        admin.email,
        admin.role,
        ...permissions.map(
          (permission) => PERMISSION_DISPLAY[permission] ?? permission,
        ),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    filtered.sort((a, b) => {
      const result = compareTableValues(a.name, b.name);
      return sortDirection === "asc" ? result : -result;
    });

    return filtered;
  }, [admins, search, sortDirection]);

  const paged = paginateRows(rows, page, pageSize);

  const handleSort = () => {
    setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    setPage(1);
  };

  return (
    <>
      <ManagedTableToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        placeholder="Search admins, roles, or permissions..."
        countLabel={`${rows.length} of ${admins.length} admins`}
      />

      <div className="overflow-hidden rounded-lg bg-card shadow">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <SortableTableHeader
                  label="Admin"
                  sortKey="admin"
                  activeSort="admin"
                  direction={sortDirection}
                  onSort={handleSort}
                  className="sticky left-0 z-10 bg-muted"
                />
                {ALL_PERMISSIONS.map((p) => (
                  <th
                    key={p}
                    className="px-3 py-3 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground"
                    title={p}
                  >
                    {PERMISSION_DISPLAY[p] ?? p}
                  </th>
                ))}
                <th className="px-3 py-3 text-center text-xs font-medium uppercase text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {paged.rows.map((admin) => {
                const isSuperAdmin = admin.role === "SUPER_ADMIN";
                const perms = Array.isArray(admin.permissions)
                  ? admin.permissions
                  : [];
                return (
                  <tr key={admin.uid} className="hover:bg-muted">
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-6 py-4">
                      <div className="text-sm font-medium text-foreground">
                        {admin.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {admin.role}
                      </div>
                    </td>
                    {ALL_PERMISSIONS.map((perm) => {
                      const has = isSuperAdmin || perms.includes(perm);
                      return (
                        <td
                          key={perm}
                          className="whitespace-nowrap px-3 py-4 text-center"
                        >
                          <span
                            className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${has ? "bg-success/10" : "bg-muted"}`}
                          >
                            {has ? (
                              <CheckIcon className="h-4 w-4 text-success" />
                            ) : (
                              <CloseIcon className="h-4 w-4 text-muted-foreground" />
                            )}
                          </span>
                        </td>
                      );
                    })}
                    <td className="px-3 py-4 text-center">
                      {!isSuperAdmin && (
                        <button
                          onClick={() => onEdit(admin)}
                          className="text-sm font-medium text-primary hover:text-primary"
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={ALL_PERMISSIONS.length + 2}
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
        onPageSizeChange={(value) => {
          setPageSize(value);
          setPage(1);
        }}
        itemLabel="admins"
      />
    </>
  );
}
