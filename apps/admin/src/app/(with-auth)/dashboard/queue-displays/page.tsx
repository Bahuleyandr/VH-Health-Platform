"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Monitor, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import {
  getQueueDisplayBoard,
  getQueueDisplaySettings,
  listQueueDisplayProfiles,
  type QueueDisplayBoardItem,
} from "@/lib/api/queueDisplays";

const APPOINTMENTS_CHANNEL = "staff:appointments";

function statusLabel(status: QueueDisplayBoardItem["displayStatus"]) {
  if (status === "serving") return "Now serving";
  if (status === "waiting") return "Waiting";
  return "Scheduled";
}

function statusClass(status: QueueDisplayBoardItem["displayStatus"]) {
  if (status === "serving") return "border-emerald-500 bg-emerald-50 text-emerald-900";
  if (status === "waiting") return "border-sky-400 bg-sky-50 text-sky-900";
  return "border-slate-300 bg-white text-slate-700";
}

function BoardTile({ item, size }: { item: QueueDisplayBoardItem; size: string }) {
  const tokenSize = size === "extra_large" ? "text-7xl" : size === "large" ? "text-6xl" : "text-5xl";
  return (
    <div className={`rounded border p-5 shadow-sm ${statusClass(item.displayStatus)}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium uppercase tracking-wide opacity-75">{item.queueLabel}</p>
          <p className={`${tokenSize} mt-3 font-black leading-none tracking-normal`}>{item.tokenDisplay}</p>
        </div>
        <span className="whitespace-nowrap rounded-full bg-white/70 px-3 py-1 text-xs font-semibold">
          {statusLabel(item.displayStatus)}
        </span>
      </div>
      <div className="mt-5 flex items-center justify-between gap-4 text-sm font-medium">
        <span>{item.roomOrCounter ?? "Counter pending"}</span>
        <span>{item.appointmentTime ?? "--:--"}</span>
      </div>
    </div>
  );
}

export default function QueueDisplaysPage() {
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const settingsQuery = useQuery({
    queryKey: ["queue-displays", "settings"],
    queryFn: getQueueDisplaySettings,
  });
  const profilesQuery = useQuery({
    queryKey: ["queue-displays", "profiles"],
    queryFn: () => listQueueDisplayProfiles(false),
  });

  const profiles = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);
  useEffect(() => {
    if (selectedProfileId != null || profiles.length === 0) return;
    const firstActive = profiles.find((profile) => profile.isActive) ?? profiles[0];
    setSelectedProfileId(firstActive.id);
  }, [profiles, selectedProfileId]);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );
  const settings = settingsQuery.data;
  const queueDisplayDisabled = settings?.enabled === false;
  const selectedProfileInactive = selectedProfile != null && !selectedProfile.isActive;
  const canLoadBoard = settings?.enabled === true && selectedProfileId != null && !selectedProfileInactive;
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(
    APPOINTMENTS_CHANNEL,
    selectedProfileId ? [["queue-displays", "board", selectedProfileId]] : [],
    { enabled: canLoadBoard },
  );

  const boardQuery = useQuery({
    queryKey: ["queue-displays", "board", selectedProfileId],
    queryFn: () => getQueueDisplayBoard(selectedProfileId as number),
    enabled: canLoadBoard,
    refetchInterval: settingsQuery.data?.enabled
      ? Math.max(settingsQuery.data.pollIntervalSeconds, 5) * 1000
      : false,
    retry: false,
  });

  const board = boardQuery.data;
  const items = board?.items ?? [];
  const size = selectedProfile?.accessibilitySize ?? settings?.defaultAccessibilitySize ?? "standard";
  const liveLabel = subscribed ? "Live" : connected ? "Connecting" : "Offline";

  return (
    <div className="min-h-full bg-slate-50 p-4 text-slate-950 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded bg-slate-950 text-white">
            <Monitor className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-normal">Queue Displays</h2>
            <p className="text-sm text-slate-600">
              {selectedProfile?.locationLabel ?? selectedProfile?.displayName ?? "No display selected"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 rounded px-3 py-2 text-sm font-semibold ${
            subscribed ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"
          }`}>
            <Activity className="h-4 w-4" aria-hidden="true" />
            {liveLabel}
          </span>
          <button
            type="button"
            onClick={() => {
              if (canLoadBoard) void boardQuery.refetch();
            }}
            disabled={!canLoadBoard}
            className="inline-flex items-center gap-2 rounded bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(260px,360px)_1fr]">
        <div className="rounded border bg-white p-3">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Display profile
          </label>
          <select
            value={selectedProfileId ?? ""}
            onChange={(event) => setSelectedProfileId(Number(event.target.value))}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}{profile.isActive ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded border bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tenant setting</p>
            <p className={`mt-2 text-lg font-bold ${settings?.enabled ? "text-emerald-700" : "text-amber-700"}`}>
              {settings?.enabled ? "Enabled" : "Disabled"}
            </p>
          </div>
          <div className="rounded border bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Poll fallback</p>
            <p className="mt-2 text-lg font-bold">{settings?.pollIntervalSeconds ?? 15}s</p>
          </div>
          <div className="rounded border bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last update</p>
            <p className="mt-2 text-lg font-bold">
              {lastEventAt ? new Date(lastEventAt).toLocaleTimeString() : board?.generatedAt ? new Date(board.generatedAt).toLocaleTimeString() : "-"}
            </p>
          </div>
        </div>
      </div>

      {settingsQuery.isLoading || profilesQuery.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : profiles.length === 0 ? (
        <div className="rounded border bg-white p-12 text-center text-slate-600">No queue display profiles configured.</div>
      ) : queueDisplayDisabled ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-8 text-amber-900">
          Queue displays are disabled for this tenant.
        </div>
      ) : selectedProfileInactive ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-8 text-amber-900">
          Queue display profile is inactive.
        </div>
      ) : boardQuery.isError ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-8 text-amber-900">
          {boardQuery.error instanceof Error ? boardQuery.error.message : "Queue display unavailable"}
        </div>
      ) : boardQuery.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="rounded border bg-white p-4">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                {board?.profile.displayName}
              </p>
              <h3 className="text-3xl font-black tracking-normal">
                {board?.profile.queueLabelOverride ?? items[0]?.queueLabel ?? "Queue Board"}
              </h3>
            </div>
            <div className="text-right text-sm font-medium text-slate-500">
              <p>Identity: token only</p>
              <p>{items.length} visible token{items.length === 1 ? "" : "s"}</p>
            </div>
          </div>
          {items.length === 0 ? (
            <div className="rounded border border-dashed p-16 text-center text-slate-500">No waiting tokens.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <BoardTile key={item.appointmentId} item={item} size={size} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
