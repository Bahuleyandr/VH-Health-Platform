// src/app/(with-auth)/dashboard/components/DashboardCharts.tsx
// Analytics mini-bar chart + Recent Activity feed for the admin Dashboard.

'use client';

import React from 'react';
import type { ActivityItem, ChartsState } from '../hooks/useDashboardData.types';

// ── Helpers ────────────────────────────────────────────────────────────

function toTimeAgo(iso?: string) {
  if (!iso) return 'just now';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

// ── MiniBars (no external deps) ────────────────────────────────────────

function MiniBars({ labels, a, b }: { labels: string[]; a: number[]; b: number[] }) {
  const max = Math.max(1, ...a, ...b);
  return (
    <div className="mt-2">
      <div className="grid grid-cols-7 gap-2 h-48 items-end">
        {labels.map((lbl, i) => (
          <div key={lbl} className="flex h-full w-full items-end gap-1">
            <div
              className="w-1/2 rounded bg-primary/80"
              style={{ height: `${((a[i] ?? 0) / max) * 100}%` }}
              title={`Users \u2022 ${a[i] ?? 0}`}
            />
            <div
              className="w-1/2 rounded bg-secondary/80"
              style={{ height: `${((b[i] ?? 0) / max) * 100}%` }}
              title={`Appointments \u2022 ${b[i] ?? 0}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-primary/80" /> Users</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-secondary/80" /> Appointments</span>
      </div>
    </div>
  );
}

// ── Exported Section ───────────────────────────────────────────────────

interface Props {
  charts: ChartsState;
  activity: ActivityItem[];
}

export function AnalyticsAndActivity({ charts, activity }: Props) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Chart */}
      <div className="lg:col-span-2 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Analytics Overview</h2>
          <div className="flex items-center gap-2">
            <select className="rounded-md border border-border bg-background px-2 py-1 text-sm">
              <option>Last 7 days</option>
              <option>Last 30 days</option>
              <option>Last 3 months</option>
            </select>
          </div>
        </div>
        <MiniBars labels={charts.labels} a={charts.users} b={charts.appts} />
      </div>

      {/* Activity Feed */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Recent Activity</h2>
        </div>
        <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
          {activity.map((a) => (
            <div key={a.id} className="rounded-lg bg-muted p-3">
              <p className="text-sm">
                <strong className="font-medium text-primary">{a.user}</strong> {a.action}{' '}
                <em className="not-italic text-foreground/90">{a.target}</em>
              </p>
              <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
                {a.department ? <span className="rounded bg-background/60 px-1.5 py-0.5">{a.department}</span> : null}
                <span>{toTimeAgo(a.timestamp)}</span>
              </div>
            </div>
          ))}
          {activity.length === 0 && (
            <p className="text-sm text-muted-foreground">No recent activity.</p>
          )}
        </div>
      </div>
    </section>
  );
}
