// Read-only table view of every admin's permissions. Per-row "Edit" button
// invokes the passed callback so the parent can mount the edit modal.
"use client";

import { CheckIcon, CloseIcon } from "@/components/icons";
import type { AdminUser } from "@/lib/types";
import { ALL_PERMISSIONS, PERMISSION_DISPLAY } from "./permissionsConfig";

interface PermissionGridProps {
  admins: AdminUser[];
  onEdit: (admin: AdminUser) => void;
}

export function PermissionGrid({ admins, onEdit }: PermissionGridProps) {
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-muted">
            <tr>
              <th className="sticky left-0 z-10 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground bg-muted">
                Admin
              </th>
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
            {admins.map((admin) => {
              const isSuperAdmin = admin.role === "SUPER_ADMIN";
              const perms = Array.isArray(admin.permissions)
                ? admin.permissions
                : [];
              return (
                <tr key={admin.uid} className="hover:bg-muted">
                  <td className="sticky left-0 z-10 whitespace-nowrap px-6 py-4 bg-white">
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
  );
}
