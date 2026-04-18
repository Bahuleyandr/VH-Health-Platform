// src/lib/api/infrastructure.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export interface AuditLogParams {
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  [key: string]: string | number | boolean | undefined | null;
}

/**
 * GET /api/v1/logs/audit
 * Paginated admin audit log entries.
 */
export function getAuditLogs<T = unknown>(params?: AuditLogParams) {
  return getJSON<T>(API_ENDPOINTS.infrastructure.auditLog, params);
}

/**
 * GET /api/v1/logs/audit/export
 * Download audit log as CSV.
 */
export function exportAuditLogs<T = unknown>(params?: AuditLogParams) {
  return getJSON<T>(API_ENDPOINTS.infrastructure.auditLogExport, params);
}

/**
 * GET /api/v1/logs/system
 * Paginated system/admin activity logs.
 */
export function getSystemLogs<T = unknown>(params?: AuditLogParams) {
  return getJSON<T>(API_ENDPOINTS.infrastructure.systemLog, params);
}

/**
 * GET /api/v1/logs/system/export
 * Download system logs as CSV.
 */
export function exportSystemLogs<T = unknown>(params?: AuditLogParams) {
  return getJSON<T>(API_ENDPOINTS.infrastructure.systemLogExport, params);
}

/**
 * POST /api/v1/rbac/admin/toggle-user-status
 */
export function toggleUserStatus<T = unknown>(userId: string, active: boolean) {
  return postJSON<T>(API_ENDPOINTS.infrastructure.toggleUserStatus, {
    userId,
    active
  });
}
