// src/lib/api/uploads.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getUploadSummary<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.uploads.summary);
}

export function getQuarantinedFiles<T = unknown>(limit = 50, offset = 0) {
  return getJSON<T>(API_ENDPOINTS.admin.uploads.quarantined, { limit, offset });
}

export function getHipaaAuditReport<T = unknown>(params?: {
  limit?: number;
  offset?: number;
  startDate?: string | null;
  endDate?: string | null;
}) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.hipaaAudit, params || {});
}

export function rescanFile<T = unknown>(fileId: string) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.rescan, { fileId });
}

export function cleanupExpiredFiles<T = unknown>(dryRun = true) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.cleanup, { dryRun });
}

export function bulkUpdateHipaaProtection<T = unknown>(
  ids: string[], 
  protect: boolean
) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.bulkHipaa, { 
    ids, 
    protect 
  });
}

export function purgeQuarantinedFiles<T = unknown>(dryRun = true) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.purgeQuarantine, { dryRun });
}
