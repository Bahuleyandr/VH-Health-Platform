// src/hooks/useUploads.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import toast from "react-hot-toast";

// ---------- Types ----------
export interface UploadSummary {
  total: number;
  hipaaProtected: number;
  quarantined: number;
  expired: number;
}

export interface QuarantinedFile {
  id: string;
  filename: string;
  reason: string;
  uploadedAt: string;
  // add fields as needed
}

export interface HipaaAuditEntry {
  id: string;
  action: string;
  timestamp: string;
  userId: string;
  // add fields as needed
}

export interface CleanupResult {
  dryRun: boolean;
  deleted: number;
  files?: string[];
}

export interface BulkUpdateResult {
  updated: number;
  failed?: string[];
}

export interface HipaaAuditFilters {
  limit?: number;
  offset?: number;
  startDate?: string;
  endDate?: string;
}

// ---------- Query Keys ----------
const QK = {
  uploadsRoot: ["admin", "uploads"] as const,
  summary: () => ["admin", "uploads", "summary"] as const,
  quarantined: (limit = 50, offset = 0) =>
    ["admin", "uploads", "quarantined", { limit, offset }] as const,
  hipaaAudit: (filters?: HipaaAuditFilters) =>
    ["admin", "uploads", "hipaa-audit", filters ?? {}] as const,
};

// NOTE: ensure fetchAdminAPI is typed like:
// export async function fetchAdminAPI<T>(path: string, init?: RequestInit): Promise<T> { ... }

// ---------- Queries ----------
export const useUploadSummary = () => {
  return useQuery({
    queryKey: QK.summary(),
    queryFn: () => fetchAdminAPI<UploadSummary>(API_ENDPOINTS.admin.uploads.summary),
    staleTime: 60_000,
  });
};

export const useQuarantinedFiles = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: QK.quarantined(limit, offset),
    queryFn: () =>
      fetchAdminAPI<{ files: QuarantinedFile[]; total: number }>(
        `${API_ENDPOINTS.admin.uploads.quarantined}?limit=${limit}&offset=${offset}`
      ),
  });
};

export const useHipaaAuditReport = (filters?: HipaaAuditFilters) => {
  // enabled: false so consumers call .refetch() when they’re ready
  return useQuery({
    queryKey: QK.hipaaAudit(filters),
    queryFn: ({ signal }) =>
      fetchAdminAPI<{ entries: HipaaAuditEntry[]; total: number }>(
        `${API_ENDPOINTS.admin.uploads.hipaaAudit}?limit=${filters?.limit ?? 50}&offset=${filters?.offset ?? 0}${filters?.startDate ? `&start_date=${encodeURIComponent(filters.startDate)}` : ""}${filters?.endDate ? `&end_date=${encodeURIComponent(filters.endDate)}` : ""}`,
        {
          method: "GET",
          // pass AbortSignal so React Query can cancel in-flight requests
          signal,
        } as RequestInit & { signal: AbortSignal }
      ),
    enabled: false,
  });
};

// ---------- Mutations ----------
export const useCleanupExpiredFiles = () => {
  const queryClient = useQueryClient();

  return useMutation<CleanupResult, Error, boolean>({
    mutationFn: (dryRun: boolean) =>
      fetchAdminAPI<CleanupResult>(API_ENDPOINTS.admin.uploads.cleanup, {
        method: "POST",
        body: JSON.stringify({ dryRun }),
      }),
    onSuccess: (data) => {
      if (data.dryRun) {
        toast(`Dry run: would delete ${data.deleted} files`, { icon: "🧪" });
        return;
      }
      // Invalidate everything under ["admin","uploads"]
      queryClient.invalidateQueries({ queryKey: QK.uploadsRoot });
      toast.success(`Cleaned up ${data.deleted} expired files`);
    },
    onError: (error) => {
      toast.error(`Cleanup failed: ${error.message}`);
    },
  });
};

export const useBulkUpdateHipaa = () => {
  const queryClient = useQueryClient();

  return useMutation<
    BulkUpdateResult,
    Error,
    { ids: string[]; protect: boolean }
  >({
    mutationFn: ({ ids, protect }) =>
      fetchAdminAPI<BulkUpdateResult>(API_ENDPOINTS.admin.uploads.bulkHipaa, {
        method: "POST",
        body: JSON.stringify({ ids, protect }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QK.uploadsRoot });
      toast.success(`Updated HIPAA protection for ${data.updated} files`);
      if (data.failed?.length) {
        toast(`Some failed: ${data.failed.length}`, { icon: "⚠️" });
      }
    },
    onError: (error) => {
      toast.error(`Bulk update failed: ${error.message}`);
    },
  });
};
