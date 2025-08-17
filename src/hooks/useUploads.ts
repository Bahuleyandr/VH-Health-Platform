// src/hooks/useUploads.ts

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import toast from "react-hot-toast";

// Upload Summary
export const useUploadSummary = () => {
  return useQuery({
    queryKey: ["admin", "uploads", "summary"],
    queryFn: () => fetchAdminAPI("/admin/uploads/summary"),
    staleTime: 60000,
  });
};

// Quarantined Files
export const useQuarantinedFiles = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: ["admin", "uploads", "quarantined", { limit, offset }],
    queryFn: () => 
      fetchAdminAPI(`/admin/uploads/quarantined?limit=${limit}&offset=${offset}`),
  });
};

// HIPAA Audit Report
export const useHipaaAuditReport = (filters?: {
  limit?: number;
  offset?: number;
  startDate?: string;
  endDate?: string;
}) => {
  return useQuery({
    queryKey: ["admin", "uploads", "hipaa-audit", filters],
    queryFn: () => fetchAdminAPI("/admin/uploads/hipaa-audit", {
      method: "POST",
      body: JSON.stringify(filters || {}),
    }),
    enabled: false, // Manual trigger
  });
};

// Cleanup Expired Files
export const useCleanupExpiredFiles = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (dryRun: boolean) => 
      fetchAdminAPI("/admin/uploads/cleanup", {
        method: "POST",
        body: JSON.stringify({ dryRun }),
      }),
    onSuccess: (data) => {
      if (!data.dryRun) {
        queryClient.invalidateQueries({ queryKey: ["admin", "uploads"] });
        toast.success(`Cleaned up ${data.deleted} expired files`);
      }
    },
  });
};

// Bulk Update HIPAA Protection
export const useBulkUpdateHipaa = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ ids, protect }: { ids: string[]; protect: boolean }) =>
      fetchAdminAPI("/admin/uploads/hipaa-bulk", {
        method: "POST",
        body: JSON.stringify({ ids, protect }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "uploads"] });
      toast.success(`Updated HIPAA protection for ${data.updated} files`);
    },
  });
};