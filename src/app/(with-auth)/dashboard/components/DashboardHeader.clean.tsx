// src/app/(with-auth)/dashboard/components/DashboardHeader.clean.tsx
// Top bar for the CleanDashboard: greeting, date, live indicator, refresh button.

'use client';

import React, { useMemo } from 'react';
import {
  UPDATED_BADGE_WARN_SECONDS,
  UPDATED_BADGE_CRITICAL_SECONDS,
  UPDATED_BADGE_JUST_NOW_SECONDS,
} from '@/lib/constants';

interface Props {
  secondsAgo: number;
  refreshing: boolean;
  onRefresh: () => void;
}

export function DashboardHeaderClean({ secondsAgo, refreshing, onRefresh }: Props) {
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 20) return 'Good evening';
    return 'Good night';
  }, []);

  const indicatorColor =
    secondsAgo < UPDATED_BADGE_WARN_SECONDS
      ? '#22c55e'
      : secondsAgo < UPDATED_BADGE_CRITICAL_SECONDS
      ? '#eab308'
      : '#ef4444';

  return (
    <header className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3 justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{greeting}, Admin</h1>
          <p className="text-sm text-muted-foreground">
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Live indicator badge */}
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: indicatorColor,
                animation: 'pulse 2s infinite',
              }}
            />
            Updated {secondsAgo < UPDATED_BADGE_JUST_NOW_SECONDS ? 'just now' : `${secondsAgo}s ago`}
          </span>

          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
          >
            <span className={refreshing ? 'animate-spin' : ''}>🔄</span>
            Refresh
          </button>
        </div>
      </div>
    </header>
  );
}
