// src/lib/api/users.ts
import { getJSON, putJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getUsers<T = unknown>(params?: {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
}) {
  return getJSON<T>(API_ENDPOINTS.users.list, params);
}

export function getUsersByRole<T = unknown>(role: string) {
  return getJSON<T>(API_ENDPOINTS.users.byRole.replace(":role", role));
}

export function updateUserStatus<T = unknown>(userId: string, status: string) {
  return putJSON<T>(API_ENDPOINTS.users.status.replace(":identifier", userId), {
    status,
  });
}

export function getInactiveUsers<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.users.inactiveUsers);
}

export function reactivateUser<T = unknown>(userId: string) {
  return postJSON<T>(API_ENDPOINTS.users.reactivate.replace(":userId", userId));
}
