// src/lib/api/departments.ts
import { getJSON, postJSON, putJSON, deleteJSON } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getDepartments<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.departments.list);
}

export function createDepartment<T = unknown>(data: {
  name: string;
  description?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.departments.create, data);
}

export function updateDepartment<T = unknown>(
  id: string,
  data: { name?: string; description?: string }
) {
  return putJSON<T>(API_ENDPOINTS.departments.update.replace(":id", id), data);
}

export function deleteDepartment<T = unknown>(id: string) {
  return deleteJSON<T>(API_ENDPOINTS.departments.delete.replace(":departmentId", id));
}

// --- New admin endpoints ---

export function getDepartmentStaffAllocation<T = unknown>(id: string) {
  return getJSON<T>(API_ENDPOINTS.departments.staffAllocation.replace(":id", id));
}

export function getDepartmentHistory<T = unknown>(id: string, params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.departments.history.replace(":id", id), params);
}

export function exportDepartmentsCsv<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.departments.exportCsv);
}
