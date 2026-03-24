// src/lib/api/admin.ts
import { postJSON, putJSON } from "./core";

export function createAdminUser<T = unknown>(payload: {
  email: string;
  password: string;
  role: string;
  permissions?: string[];
}) {
  return postJSON<T>("/api/v1/auth/admin/create-admin", payload);
}

export function deactivateAdmin<T = unknown>(id: number): Promise<T>;
export function deactivateAdmin<T = unknown>(payload: {
  adminId: number;
  reason?: string;
}): Promise<T>;
export function deactivateAdmin<T = unknown>(
  arg: number | { adminId: number; reason?: string },
) {
  const id = typeof arg === "number" ? arg : arg.adminId;
  const reason = typeof arg === "object" ? arg.reason : undefined;
  return postJSON<T>("/api/v1/auth/admin/deactivate", { adminId: id, reason: reason || "Deactivated by admin" });
}

export function reactivateAdmin<T = unknown>(id: number): Promise<T>;
export function reactivateAdmin<T = unknown>(payload: {
  adminId: number;
}): Promise<T>;
export function reactivateAdmin<T = unknown>(
  arg: number | { adminId: number },
) {
  const id = typeof arg === "number" ? arg : arg.adminId;
  return postJSON<T>("/api/v1/auth/admin/reactivate", { adminId: id });
}

export function updateAdminPermissions<T = unknown>(
  id: number,
  perms: string[],
): Promise<T>;
export function updateAdminPermissions<T = unknown>(payload: {
  adminId: number;
  permissions: string[];
}): Promise<T>;
export function updateAdminPermissions<T = unknown>(
  a: number | { adminId: number; permissions: string[] },
  perms?: string[],
) {
  const id = typeof a === "number" ? a : a.adminId;
  const permissions = typeof a === "number" ? (perms ?? []) : a.permissions;
  return putJSON<T>("/api/v1/auth/admin/update-permissions", { adminId: id, permissions });
}
