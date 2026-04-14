"use client";

// Live KPI tiles fed by the admin:kpi channel of the real-time fabric. The
// backend aggregator (utils/kpiAggregator.js) ticks every 30s and also primes
// the channel once at startup, so tiles paint on the first frame after
// connection. An aggregate bed-occupancy tile and a today's-queue tile are
// rendered side-by-side.

import React from "react";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";

type KpiEnvelope = {
  tile: string;
  value: Record<string, number>;
  at?: string;
};

export default function LiveBedOccupancyTile() {
  const { lastMessage, connected } = useRealtimeChannel<KpiEnvelope>("admin:kpi");

  // Keep the most recent value seen for each tile name, so distinct tiles
  // don't clobber each other when their updates interleave.
  const [tiles, setTiles] = React.useState<Record<string, KpiEnvelope>>({});
  React.useEffect(() => {
    if (!lastMessage) return;
    const env = lastMessage.data;
    if (!env?.tile) return;
    setTiles((prev) => ({ ...prev, [env.tile]: env }));
  }, [lastMessage]);

  const occupancy = tiles["bed-occupancy"]?.value;
  const queue = tiles["waiting-queue"]?.value;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Live Operations</h3>
        <span
          className={`inline-flex items-center gap-1 text-xs ${
            connected ? "text-emerald-400" : "text-muted-foreground"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-emerald-500 animate-pulse" : "bg-gray-500"
            }`}
          />
          {connected ? "Live" : "Connecting…"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <BedOccupancyCard value={occupancy} />
        <WaitingQueueCard value={queue} />
      </div>
    </div>
  );
}

function BedOccupancyCard({ value }: { value?: Record<string, number> }) {
  const pct = value?.occupancyPct;
  const occupied = value?.occupied;
  const total = value?.total;
  const color =
    pct == null
      ? "text-muted-foreground"
      : pct >= 90
        ? "text-red-400"
        : pct >= 75
          ? "text-amber-400"
          : "text-emerald-400";
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        Bed occupancy
      </p>
      <p className={`mt-1 text-3xl font-bold ${color}`}>
        {pct == null ? "—" : `${pct}%`}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {occupied == null || total == null
          ? "Waiting for first tick…"
          : `${occupied} of ${total} occupied`}
      </p>
    </div>
  );
}

function WaitingQueueCard({ value }: { value?: Record<string, number> }) {
  const waiting = value?.waiting;
  const inProgress = value?.inProgress;
  const activeDoctors = value?.activeDoctors;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        Today&apos;s queue
      </p>
      <p className="mt-1 text-3xl font-bold text-white">
        {waiting == null ? "—" : waiting}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {inProgress == null
          ? "Waiting for first tick…"
          : `${inProgress} in consult · ${activeDoctors ?? 0} doctors active`}
      </p>
    </div>
  );
}
