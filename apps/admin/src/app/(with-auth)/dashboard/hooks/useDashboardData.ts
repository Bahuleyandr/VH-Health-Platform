// src/app/(with-auth)/dashboard/hooks/useDashboardData.ts
// Custom hook that encapsulates all dashboard data fetching logic.

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  SECONDS_AGO_TICK_MS,
  ACTIVITY_FEED_LIMIT,
} from '@/lib/constants';
import type {
  Quick,
  ActivityItem,
  SystemHealth,
  AppointmentQueue,
  InfraHealthData,
  DashboardResponse,
  HealthStatus,
  ChartsState,
} from './useDashboardData.types';

export type {
  Quick,
  ActivityItem,
  SystemHealth,
  AppointmentQueue,
  InfraHealthData,
  HealthStatus,
  ChartsState,
};

export function useDashboardData() {
  // ---- Local state ----
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quick, setQuick] = useState<Quick>({});
  const [prevQuick, setPrevQuick] = useState<Quick>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [charts, setCharts] = useState<ChartsState>({ labels: [], users: [], appts: [] });
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [queue, setQueue] = useState<AppointmentQueue>({ waiting: 0, inProgress: 0, completed: 0 });
  const [prevQueue, setPrevQueue] = useState<AppointmentQueue>({ waiting: 0, inProgress: 0, completed: 0 });
  const [infraHealth, setInfraHealth] = useState<InfraHealthData | null>(null);

  // ---- Helpers ----
  // Auth is carried via the httpOnly auth_token cookie handled by /api/proxy.
  const headers = getHeaders();
  const headersRef = useRef(headers);
  headersRef.current = headers;

  const get = useCallback(async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: headersRef.current });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }, []);

  const post = useCallback(async function post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...headersRef.current, 'Content-Type': 'application/json' },
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
  const loadAll = useCallback(async function loadAll() {
    setLoading(true);
    try {
      const dash = await get<DashboardResponse>(API_ENDPOINTS.admin.dashboard);
      const quickStats = await get<{ data?: Quick }>(API_ENDPOINTS.admin.stats.quick).catch(() => null);
      const recent = await get<{ data?: ActivityItem[]; items?: ActivityItem[] }>(
        API_ENDPOINTS.admin.activity.recent + `?limit=${ACTIVITY_FEED_LIMIT}&offset=0`
      ).catch(() => null);
      const sys = await get<{ data?: SystemHealth }>(API_ENDPOINTS.admin.health.system).catch(() => null);

      // Appointment stats for queue
      const apptStats = await get<{ data?: { waiting?: number; in_progress?: number; completed?: number; inProgress?: number } }>(
        API_ENDPOINTS.admin.stats.appointments
      ).catch(() => null);

      // Module health
      const moduleHealth = await get<{ data?: Array<{ name: string; status: HealthStatus }> }>(
        API_ENDPOINTS.admin.health.modules
      ).catch(() => null);

      // Infrastructure health (deep system check)
      // Disabled for now: the separate system health endpoint uses different
      // auth expectations than the admin dashboard flow and only produced
      // console noise without affecting visible dashboard functionality.
      setInfraHealth(null);

      // Normalize
      const overview = dash?.overview ?? {};
      const newQuick: Quick = {
        totalUsers: quickStats?.data?.totalUsers ?? overview.totalUsers ?? 0,
        presentStaff: overview.presentStaff ?? 0,
        availableDoctors: overview.availableDoctors ?? 0,
        appointmentsToday: overview.appointmentsToday ?? 0,
      };
      setPrevQuick(quick);
      setQuick(newQuick);

      // Queue
      const newQueue: AppointmentQueue = {
        waiting: apptStats?.data?.waiting ?? 0,
        inProgress: apptStats?.data?.inProgress ?? apptStats?.data?.in_progress ?? 0,
        completed: apptStats?.data?.completed ?? 0,
      };
      setPrevQueue(queue);
      setQueue(newQueue);

      const ug = dash?.charts?.userGrowth ?? [];
      const at = dash?.charts?.appointmentTrends ?? [];
      setCharts({
        labels: ug.length ? ug.map((d) => d.date) : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        users: ug.length ? ug.map((d) => d.value) : [65, 78, 90, 81, 84, 78, 95],
        appts: at.length ? at.map((d) => d.value) : [58, 68, 77, 89, 76, 77, 88],
      });

      const act = recent?.data ?? recent?.items ?? dash?.recentActivity ?? [];
      setActivity(
        (act ?? []).slice(0, ACTIVITY_FEED_LIMIT).map((a, i) => ({
          id: a?.id ?? String(i),
          user: a?.user ?? 'System',
          action: a?.action ?? 'updated',
          target: a?.target ?? 'record',
          department: a?.department,
          timestamp: a?.timestamp ?? new Date().toISOString(),
        }))
      );

      const healthData = sys?.data ??
        dash?.systemHealth ?? {
          status: 'healthy' as HealthStatus,
          uptime: '99.99%',
          responseTime: 45,
          errorRate: 0.1,
        };

      // Merge module health
      if (moduleHealth?.data) {
        healthData.modules = moduleHealth.data;
      }

      setHealth(healthData);
      setLastUpdated(new Date());
      setSecondsAgo(0);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get]);

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
