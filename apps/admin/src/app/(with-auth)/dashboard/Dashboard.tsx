// src/app/(with-auth)/dashboard/Dashboard.tsx
// Thin orchestrator -- delegates to focused sub-components.

"use client";

import React from "react";
import Link from "next/link";
import { Activity, CalendarCheck, ShieldCheck, Users } from "lucide-react";
import { useDashboardData } from "./hooks/useDashboardData";
import { DashboardHeader } from "./components/DashboardHeader";
import { StatCards, AppointmentQueueCards } from "./components/DashboardStats";
import { AnalyticsAndActivity } from "./components/DashboardCharts";
import {
  SystemHealthSection,
  InfrastructureMonitor,
} from "./components/SystemHealthPanel";
import LiveBedOccupancyTile from "./components/LiveBedOccupancyTile";

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
        <StatCards quick={quick} prevQuick={prevQuick} />
        <AppointmentQueueCards queue={queue} prevQueue={prevQueue} />
        <LiveBedOccupancyTile />
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
