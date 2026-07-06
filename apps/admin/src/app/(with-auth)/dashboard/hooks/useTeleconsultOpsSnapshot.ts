"use client";

import { useQuery } from "@tanstack/react-query";
import { getTeleconsultOpsSnapshot, type TeleconsultOpsSnapshot } from "@/lib/api/dashboard";
import { useRealtimeData } from "@/hooks/useRealtimeData";

export const TELECONSULT_OPS_QUERY_KEY = ["dashboards", "teleconsult-ops"] as const;
const TELECONSULT_OPS_FALLBACK_POLL_MS = 30_000;
const TELECONSULT_OPS_LIVE_POLL_MS = 300_000;

export function useTeleconsultOpsSnapshot() {
  const realtime = useRealtimeData<TeleconsultOpsSnapshot>(
    "admin:teleconsult-ops",
    TELECONSULT_OPS_QUERY_KEY,
  );

  const query = useQuery<TeleconsultOpsSnapshot>({
    queryKey: TELECONSULT_OPS_QUERY_KEY,
    queryFn: getTeleconsultOpsSnapshot,
    refetchInterval: realtime.subscribed
      ? TELECONSULT_OPS_LIVE_POLL_MS
      : TELECONSULT_OPS_FALLBACK_POLL_MS,
  });

  return {
    ...query,
    realtime,
  };
}
