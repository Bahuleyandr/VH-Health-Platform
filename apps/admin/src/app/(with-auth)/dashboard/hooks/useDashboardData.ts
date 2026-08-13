// src/app/(with-auth)/dashboard/hooks/useDashboardData.ts
// Custom hook that encapsulates all dashboard data fetching logic.

import { useCallback, useEffect, useRef, useState } from "react";
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from "@/lib/api-config";
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  SECONDS_AGO_TICK_MS,
  ACTIVITY_FEED_LIMIT,
} from "@/lib/constants";
import type {
  Quick,
  ActivityItem,
  SystemHealth,
  AppointmentQueue,
  InfraHealthData,
  DashboardResponse,
  HealthStatus,
  ChartsState,
} from "./useDashboardData.types";

type MaybeDataEnvelope<T> = T | { data?: T };

export type {
  Quick,
  ActivityItem,
  SystemHealth,
  AppointmentQueue,
  InfraHealthData,
  HealthStatus,
  ChartsState,
};

function unwrapData<T>(
  payload: MaybeDataEnvelope<T> | null | undefined,
): T | undefined {
  if (payload == null) return undefined;
  if (
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload &&
    payload.data !== undefined
  ) {
    return payload.data;
  }
  return payload as T;
}

function normalizeHealthStatus(status: unknown): HealthStatus {
  const value = String(status ?? "")
    .trim()
    .toLowerCase();
  if (value === "healthy" || value === "ok" || value === "up") return "healthy";
  if (value === "warning" || value === "degraded") return "warning";
  if (["critical", "unhealthy", "down", "error", "failed"].includes(value))
    return "critical";
  return "unknown";
}

function observedHealth(
  value: SystemHealth,
  modules?: Array<{ name: string; status: HealthStatus }>,
): SystemHealth {
  return {
    ...value,
    status: normalizeHealthStatus(value.status),
    ...(modules ? { modules } : {}),
    observedAt: new Date().toISOString(),
  };
}

function normalizeModuleHealth(
  modules: Array<{ name: string; status: unknown }> | undefined,
): Array<{ name: string; status: HealthStatus }> | undefined {
  return modules?.map((module) => ({
    name: module.name,
    status: normalizeHealthStatus(module.status),
  }));
}

export function useDashboardData() {
  // ---- Local state ----
  const initialQueue: AppointmentQueue = {
    waiting: 0,
    inProgress: 0,
    completed: 0,
  };
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quick, setQuick] = useState<Quick>({});
  const [prevQuick, setPrevQuick] = useState<Quick>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [health, setHealth] = useState<SystemHealth>({ status: "unknown" });
  const [charts, setCharts] = useState<ChartsState>({
    labels: [],
    users: [],
    appts: [],
  });
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [queue, setQueue] = useState<AppointmentQueue>(initialQueue);
  const [prevQueue, setPrevQueue] = useState<AppointmentQueue>(initialQueue);
  const [infraHealth, setInfraHealth] = useState<InfraHealthData | null>(null);

  // ---- Helpers ----
  // Auth is carried via the httpOnly auth_token cookie handled by /api/proxy.
  const headers = getHeaders();
  const headersRef = useRef(headers);
  const quickRef = useRef<Quick>({});
  const queueRef = useRef<AppointmentQueue>(initialQueue);
  const healthRef = useRef<SystemHealth>({ status: "unknown" });
  headersRef.current = headers;

  const get = useCallback(async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: headersRef.current,
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }, []);

  const post = useCallback(async function post<T>(
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { ...headersRef.current, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }, []);

  // ---- Live "seconds ago" ticker ----
  useEffect(() => {
    const t = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, SECONDS_AGO_TICK_MS);
    return () => clearInterval(t);
  }, [lastUpdated]);

  // ---- Load data ----
  const loadAll = useCallback(
    async function loadAll() {
      setLoading(true);
      try {
        const [
          dashboardPayload,
          quickStatsPayload,
          recentPayload,
          systemHealthResult,
          appointmentStatsPayload,
          moduleHealthPayload,
        ] = await Promise.all([
          get<MaybeDataEnvelope<DashboardResponse>>(
            API_ENDPOINTS.admin.dashboard,
          ).catch(() => null),
          get<MaybeDataEnvelope<Quick>>(API_ENDPOINTS.admin.stats.quick).catch(
            () => null,
          ),
          get<{ data?: ActivityItem[]; items?: ActivityItem[] }>(
            API_ENDPOINTS.admin.activity.recent +
              `?limit=${ACTIVITY_FEED_LIMIT}&offset=0`,
          ).catch(() => null),
          get<MaybeDataEnvelope<SystemHealth>>(
            API_ENDPOINTS.admin.health.system,
          )
            .then((payload) => ({ ok: true as const, payload }))
            .catch(() => ({ ok: false as const, payload: null })),
          get<
            MaybeDataEnvelope<{
              waiting?: number;
              in_progress?: number;
              completed?: number;
              inProgress?: number;
            }>
          >(API_ENDPOINTS.admin.stats.appointments).catch(() => null),
          get<MaybeDataEnvelope<Array<{ name: string; status: unknown }>>>(
            API_ENDPOINTS.admin.health.modules,
          ).catch(() => null),
        ]);

        // Infrastructure health (deep system check)
        // Disabled for now: the separate system health endpoint uses different
        // auth expectations than the admin dashboard flow and only produced
        // console noise without affecting visible dashboard functionality.
        setInfraHealth(null);

        // Normalize
        const dash = unwrapData(dashboardPayload) ?? {};
        const quickStats = unwrapData(quickStatsPayload);
        const recent =
          recentPayload?.data ??
          recentPayload?.items ??
          dash.recentActivity ??
          [];
        const systemHealth = unwrapData(systemHealthResult.payload);
        const appointmentStats = unwrapData(appointmentStatsPayload);
        const moduleHealth = normalizeModuleHealth(
          unwrapData(moduleHealthPayload),
        );
        const overview = dash?.overview ?? {};
        const newQuick: Quick = {
          totalUsers: quickStats?.totalUsers ?? overview.totalUsers ?? 0,
          presentStaff: overview.presentStaff ?? 0,
          availableDoctors: overview.availableDoctors ?? 0,
          appointmentsToday: overview.appointmentsToday ?? 0,
        };
        setPrevQuick(quickRef.current);
        setQuick(newQuick);
        quickRef.current = newQuick;

        // Queue
        const newQueue: AppointmentQueue = {
          waiting: appointmentStats?.waiting ?? 0,
          inProgress:
            appointmentStats?.inProgress ?? appointmentStats?.in_progress ?? 0,
          completed: appointmentStats?.completed ?? 0,
        };
        setPrevQueue(queueRef.current);
        setQueue(newQueue);
        queueRef.current = newQueue;

        const ug = dash?.charts?.userGrowth ?? [];
        const at = dash?.charts?.appointmentTrends ?? [];
        setCharts({
          labels: ug.map((d) => d.date),
          users: ug.map((d) => d.value),
          appts: at.map((d) => d.value),
        });

        setActivity(
          recent.slice(0, ACTIVITY_FEED_LIMIT).map((a, i) => ({
            id: a?.id ?? String(i),
            user: a?.user ?? "System",
            action: a?.action ?? "updated",
            target: a?.target ?? "record",
            department: a?.department,
            timestamp: a?.timestamp ?? new Date().toISOString(),
          })),
        );

        // Use real health data from the backend; do NOT fall back to a fake
        // 99.99%/45ms/0.1% literal — that masked broken endpoints for ages.
        // Missing or failed observations remain explicit unknown/unavailable/stale states.
        const healthData = systemHealth ?? dash.systemHealth;
        let nextHealth: SystemHealth;
        if (healthData) {
          nextHealth = observedHealth(healthData, moduleHealth);
        } else if (!systemHealthResult.ok) {
          const previous = healthRef.current;
          const lastKnownStatus = ["healthy", "warning", "critical"].includes(
            previous.status,
          )
            ? (previous.status as "healthy" | "warning" | "critical")
            : previous.lastKnownStatus;
          nextHealth = lastKnownStatus
            ? {
                ...previous,
                status: "stale",
                lastKnownStatus,
                detail:
                  "Health endpoint is unavailable; showing the last observation.",
              }
            : {
                status: "unavailable",
                detail:
                  "Health endpoint is unavailable and no prior observation exists.",
              };
        } else {
          nextHealth = {
            status: "unknown",
            observedAt: new Date().toISOString(),
            detail: "Health endpoint returned no status.",
          };
        }
        healthRef.current = nextHealth;
        setHealth(nextHealth);
        setLastUpdated(new Date());
        setSecondsAgo(0);
      } finally {
        setLoading(false);
      }
    },
    [get],
  );

  async function refreshCache() {
    setRefreshing(true);
    try {
      await post(API_ENDPOINTS.admin.reports.refreshCache);
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, DASHBOARD_REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentional: run once on mount

  return {
    loading,
    refreshing,
    quick,
    prevQuick,
    activity,
    health,
    charts,
    lastUpdated,
    secondsAgo,
    queue,
    prevQueue,
    infraHealth,
    refreshCache,
  };
}
