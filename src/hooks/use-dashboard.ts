// src/hooks/use-dashboard.ts
"use client";

import { getJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import type { DashboardData } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";

export function useDashboardData() {
  return useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => getJSON<DashboardData>(API_ENDPOINTS.users.dashboard),
    staleTime: 60_000, // 1 minute
  });
}
