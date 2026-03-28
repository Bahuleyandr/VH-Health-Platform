// src/app/(with-auth)/dashboard/CleanDashboard.tsx
// Thin orchestrator -- delegates to focused sub-components.

'use client';

import React from 'react';
import { useDashboardData } from './hooks/useDashboardData';
import { DashboardHeaderClean } from './components/DashboardHeader.clean';
import { StatCards, AppointmentQueueCards } from './components/DashboardStatsClean';
import { AnalyticsAndActivity } from './components/DashboardChartsClean';
import { SystemHealthSection, InfrastructureMonitor } from './components/SystemHealthPanel';

export default function CleanDashboard() {
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
      {/* Top bar */}
      <DashboardHeaderClean
        secondsAgo={secondsAgo}
        refreshing={refreshing}
        onRefresh={refreshCache}
      />

      {/* Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        <StatCards quick={quick} prevQuick={prevQuick} />
        <AppointmentQueueCards queue={queue} prevQueue={prevQueue} />
        <AnalyticsAndActivity charts={charts} activity={activity} />
        <SystemHealthSection health={health} lastUpdated={lastUpdated} />
        {infraHealth && <InfrastructureMonitor infraHealth={infraHealth} />}
      </main>

      {/* Loading overlay */}
      {loading && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-background/60 backdrop-blur">
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-6 py-5 shadow-sm">
            <div className="text-3xl">🏥</div>
            <p className="text-sm text-muted-foreground">Loading dashboard…</p>
          </div>
        </div>
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
