// src/app/(with-auth)/dashboard/Dashboard.tsx
// Thin orchestrator -- delegates to focused sub-components.

"use client";

import React from "react";
import Link from "next/link";
import { Activity, CalendarCheck, ShieldCheck, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useRealtimeData } from "@/hooks/useRealtimeData";
import { useDashboardData } from "./hooks/useDashboardData";
import { DashboardHeader } from "./components/DashboardHeader";
import { StatCards, AppointmentQueueCards } from "./components/DashboardStats";
import { AnalyticsAndActivity } from "./components/DashboardCharts";
import {
  SystemHealthSection,
  InfrastructureMonitor,
} from "./components/SystemHealthPanel";
import LiveBedOccupancyTile from "./components/LiveBedOccupancyTile";
import TeleconsultOpsPanel from "./components/TeleconsultOpsPanel";
import type { AppointmentQueue, Quick } from "./hooks/useDashboardData.types";

const adminQuickLinks = [
  { label: "Staff Roster", href: "/dashboard/staff-roster", icon: Users },
  {
    label: "Leave Approvals",
    href: "/dashboard/leave-approvals",
    icon: CalendarCheck,
  },
  {
    label: "Attendance Audit",
    href: "/dashboard/attendance-audit",
    icon: Activity,
  },
  { label: "System Audit", href: "/dashboard/system-audit", icon: ShieldCheck },
];

const ADMIN_KPI_QUERY_KEY = ["dashboard", "admin-kpi"] as const;

type AdminKpiEnvelope = {
  tile: string;
  value?: Record<string, number>;
  at?: string;
};

function numericTileValue(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export default function Dashboard() {
  const {
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
  } = useDashboardData();
  const {
    connected: kpiConnected,
    subscribed: kpiSubscribed,
    lastEventAt: kpiLastEventAt,
  } = useRealtimeData<AdminKpiEnvelope>("admin:kpi", ADMIN_KPI_QUERY_KEY);
  const { data: latestKpi } = useQuery<AdminKpiEnvelope | null>({
    queryKey: ADMIN_KPI_QUERY_KEY,
    queryFn: async () => null,
    enabled: false,
    initialData: null,
  });
  const [kpiTiles, setKpiTiles] = React.useState<Record<string, AdminKpiEnvelope>>({});

  React.useEffect(() => {
    if (!latestKpi?.tile) return;
    setKpiTiles((prev) => ({ ...prev, [latestKpi.tile]: latestKpi }));
  }, [latestKpi]);

  const mergedKpiTiles = React.useMemo(
    () =>
      latestKpi?.tile
        ? { ...kpiTiles, [latestKpi.tile]: latestKpi }
        : kpiTiles,
    [kpiTiles, latestKpi],
  );
  const waitingQueueTile = mergedKpiTiles["waiting-queue"]?.value;
  const liveQueue = React.useMemo<AppointmentQueue>(() => {
    if (!waitingQueueTile) return queue;
    return {
      waiting: numericTileValue(waitingQueueTile.waiting, queue.waiting),
      inProgress: numericTileValue(
        waitingQueueTile.inProgress,
        queue.inProgress,
      ),
      completed: queue.completed,
    };
  }, [queue, waitingQueueTile]);
  const liveQuick = React.useMemo<Quick>(() => {
    if (!waitingQueueTile) return quick;
    return {
      ...quick,
      appointmentsToday:
        liveQueue.waiting + liveQueue.inProgress + liveQueue.completed,
    };
  }, [liveQueue, quick, waitingQueueTile]);

  const kpiLiveLabel = kpiSubscribed ? "● Live" : "○ Polling";
  const kpiLiveTitle = kpiSubscribed
    ? kpiLastEventAt
      ? `Real-time via admin:kpi - last update ${new Date(kpiLastEventAt).toLocaleTimeString()}`
      : "Real-time via admin:kpi"
    : kpiConnected
      ? "Connecting..."
      : "Polling every 30s (real-time unavailable)";

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40 text-foreground">
      <DashboardHeader
        secondsAgo={secondsAgo}
        refreshing={refreshing}
        onRefresh={refreshCache}
      />

      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {adminQuickLinks.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium text-foreground transition-colors hover:border-indigo-500/60 hover:bg-muted/50"
              >
                <span className="grid h-9 w-9 place-items-center rounded-md bg-background text-indigo-300">
                  <Icon size={18} />
                </span>
                {item.label}
              </Link>
            );
          })}
        </section>
        <div className="flex items-center justify-end">
          <span
            data-testid="dashboard-kpi-realtime-indicator"
            role="status"
            aria-label={
              kpiSubscribed
                ? "Live - real-time dashboard KPI updates active"
                : "Polling - real-time dashboard KPI updates unavailable"
            }
            title={kpiLiveTitle}
            className={
              kpiSubscribed
                ? "text-xs font-medium text-green-600"
                : "text-xs font-medium text-gray-400"
            }
          >
            {kpiLiveLabel}
          </span>
        </div>
        <StatCards quick={liveQuick} prevQuick={prevQuick} />
        <AppointmentQueueCards queue={liveQueue} prevQueue={prevQueue} />
        <LiveBedOccupancyTile />
        <TeleconsultOpsPanel />
        <AnalyticsAndActivity charts={charts} activity={activity} />
        <SystemHealthSection health={health} lastUpdated={lastUpdated} />
        {infraHealth && <InfrastructureMonitor infraHealth={infraHealth} />}
      </main>

      {loading && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-background/60 backdrop-blur">
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-6 py-5 shadow-sm">
            <Users className="text-indigo-300" size={28} />
            <p className="text-sm text-muted-foreground">
              Loading dashboard...
            </p>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
