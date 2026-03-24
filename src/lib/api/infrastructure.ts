// src/lib/api/infrastructure.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getAuditLogs<T = unknown>(params?: {
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
}) {
  return getJSON<T>(API_ENDPOINTS.infrastructure.auditLog, params);
}

export function toggleUserStatus<T = unknown>(userId: string, active: boolean) {
  return postJSON<T>(API_ENDPOINTS.infrastructure.toggleUserStatus, {
    userId,
    active
  });
}
