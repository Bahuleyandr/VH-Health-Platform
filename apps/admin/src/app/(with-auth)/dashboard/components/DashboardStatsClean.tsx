// src/app/(with-auth)/dashboard/components/DashboardStatsClean.tsx
// Stat cards + Appointment queue for the CleanDashboard.

'use client';

import React from 'react';
import {
  DOCTORS_WARNING_THRESHOLD,
  STAFF_WARNING_THRESHOLD,
} from '@/lib/constants';
import type { Quick, AppointmentQueue, HealthStatus } from '../hooks/useDashboardData.types';

// ── Helpers ────────────────────────────────────────────────────────────

function statusDotColor(s: HealthStatus) {
  return s === 'healthy' ? '#22c55e' : s === 'warning' ? '#eab308' : '#ef4444';
}

function getMetricStatus(current?: number, label?: string): HealthStatus {
  if (label === 'Available Doctors' && (current ?? 0) === 0) return 'critical';
  if (label === 'Available Doctors' && (current ?? 0) < DOCTORS_WARNING_THRESHOLD) return 'warning';
  if (label === 'Staff on Duty' && (current ?? 0) === 0) return 'critical';
  if (label === 'Staff on Duty' && (current ?? 0) < STAFF_WARNING_THRESHOLD) return 'warning';
  return 'healthy';
}

function trendArrow(current: number, previous: number): string {
  if (current > previous) return '↑';
  if (current < previous) return '↓';
  return '';
}

// ── Components ─────────────────────────────────────────────────────────

interface StatsProps {
  quick: Quick;
  prevQuick: Quick;
}

export function StatCards({ quick, prevQuick }: StatsProps) {
  const statCards = [
    { label: 'Total Patients', value: quick.totalUsers ?? 0, prev: prevQuick.totalUsers ?? 0, icon: '🏥' },
    { label: 'Staff on Duty', value: quick.presentStaff ?? 0, prev: prevQuick.presentStaff ?? 0, icon: '👥' },
    { label: 'Available Doctors', value: quick.availableDoctors ?? 0, prev: prevQuick.availableDoctors ?? 0, icon: '🩺' },
    { label: "Today's Appointments", value: quick.appointmentsToday ?? 0, prev: prevQuick.appointmentsToday ?? 0, icon: '📋' },
  ];

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {statCards.map((s) => {
        const status = getMetricStatus(s.value, s.label);
        const arrow = trendArrow(s.value, s.prev);
        return (
          <div key={s.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <span className="text-2xl" aria-hidden>{s.icon}</span>
              <span
                className="h-3 w-3 rounded-full mt-1"
                style={{ backgroundColor: statusDotColor(status) }}
                title={status}
              />
            </div>
            <div className="mt-3">
              <p className="text-sm text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-3xl font-bold tracking-tight">
                {(s.value ?? 0).toLocaleString()}
                {arrow && (
                  <span className={`ml-1 text-lg ${arrow === '↑' ? 'text-emerald-500' : 'text-destructive'}`}>
                    {arrow}
                  </span>
                )}
              </p>
            </div>
          </div>
        );
      })}
    </section>
  );
}

interface QueueProps {
  queue: AppointmentQueue;
  prevQueue: AppointmentQueue;
}

export function AppointmentQueueCards({ queue, prevQueue }: QueueProps) {
  const items = [
    { label: 'Waiting', value: queue.waiting, prev: prevQueue.waiting, color: '#eab308', bg: 'rgba(234,179,8,0.1)' },
    { label: 'In Progress', value: queue.inProgress, prev: prevQueue.inProgress, color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
    { label: 'Completed', value: queue.completed, prev: prevQueue.completed, color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  ];

  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {items.map((q) => {
        const arrow = trendArrow(q.value, q.prev);
        return (
          <div key={q.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: q.color }} />
              <span className="text-sm font-medium text-muted-foreground">Queue: {q.label}</span>
            </div>
            <p className="text-2xl font-bold">
              {q.value}
              {arrow && (
                <span className={`ml-1 text-base ${arrow === '↑' ? 'text-amber-500' : 'text-emerald-500'}`}>
                  {arrow}
                </span>
              )}
            </p>
          </div>
        );
      })}
    </section>
  );
}
