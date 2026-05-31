// src/app/(with-auth)/dashboard/components/DashboardHeader.tsx
// Top bar for the Dashboard: greeting, date, live indicator, refresh button.

"use client";

import React from "react";
import { RefreshCw } from "lucide-react";
import {
  UPDATED_BADGE_WARN_SECONDS,
  UPDATED_BADGE_CRITICAL_SECONDS,
  UPDATED_BADGE_JUST_NOW_SECONDS,
} from "@/lib/constants";

interface Props {
  secondsAgo: number;
  refreshing: boolean;
  onRefresh: () => void;
}

export function DashboardHeader({ secondsAgo, refreshing, onRefresh }: Props) {
  const indicatorColor =
    secondsAgo < UPDATED_BADGE_WARN_SECONDS
      ? "#22c55e"
      : secondsAgo < UPDATED_BADGE_CRITICAL_SECONDS
        ? "#eab308"
        : "#ef4444";

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">VH Health Command Center</h1>
          <p className="text-sm text-muted-foreground">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: indicatorColor,
                animation: "pulse 2s infinite",
              }}
            />
            Updated {secondsAgo < UPDATED_BADGE_JUST_NOW_SECONDS ? "just now" : `${secondsAgo}s ago`}
          </span>

          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>
    </header>
  );
}
