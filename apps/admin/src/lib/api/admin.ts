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

export function deactivateAdmin<T = unknown>(uid: string): Promise<T>;
export function deactivateAdmin<T = unknown>(payload: {
  adminId: string;
  reason?: string;
}): Promise<T>;
export function deactivateAdmin<T = unknown>(
  arg: string | { adminId: string; reason?: string },
) {
  const id = typeof arg === "string" ? arg : arg.adminId;
  const reason = typeof arg === "object" ? arg.reason : undefined;
  return postJSON<T>("/api/v1/auth/admin/deactivate", { adminId: id, reason: reason || "Deactivated by admin" });
}

export function reactivateAdmin<T = unknown>(uid: string): Promise<T>;
export function reactivateAdmin<T = unknown>(payload: {
  adminId: string;
}): Promise<T>;
export function reactivateAdmin<T = unknown>(
  arg: string | { adminId: string },
) {
  const id = typeof arg === "string" ? arg : arg.adminId;
  return postJSON<T>("/api/v1/auth/admin/reactivate", { adminId: id });
}

export function updateAdminPermissions<T = unknown>(
  uid: string,
  perms: string[],
): Promise<T>;
export function updateAdminPermissions<T = unknown>(payload: {
  adminId: string;
  permissions: string[];
}): Promise<T>;
export function updateAdminPermissions<T = unknown>(
  a: string | { adminId: string; permissions: string[] },
  perms?: string[],
) {
  const id = typeof a === "string" ? a : a.adminId;
  const permissions = typeof a === "string" ? (perms ?? []) : a.permissions;
  return putJSON<T>("/api/v1/auth/admin/update-permissions", { adminId: id, permissions });
}
