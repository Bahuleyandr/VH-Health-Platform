// src/app/(with-auth)/dashboard/or-board/page.tsx
//
// OR Board (Sprint 6) — coordinator's single-screen view of today's
// surgical cases. Shows scheduled cases per room with checklist
// progress, WHO 3-phase safety status, intra/postop note counts and
// open complication alerts. Auto-refreshes every 60s.

"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface OrBoardCase {
  id: number;
  patient_uid: string;
  procedure_name: string;
  procedure_code: string | null;
  surgeon: string;
  anesthetist: string | null;
  ot_room: string | null;
  scheduled_date: string;
  scheduled_time: string | null;
  estimated_duration: number | null;
  actual_duration: number | null;
  status:
    | "scheduled"
    | "pre_op"
    | "in_progress"
    | "post_op"
    | "completed"
    | "cancelled";
  blood_arranged: boolean;
  consent_obtained: boolean;
  sign_in_complete: boolean | null;
  time_out_complete: boolean | null;
  sign_out_complete: boolean | null;
  intraop_note_count: number;
  postop_note_count: number;
  open_complications: number;
}

interface OrBoardResponse {
  date: string;
  ot_room: string | null;
  cases: OrBoardCase[];
}

interface OrRoom {
  id: number;
  code: string;
  display_name: string;
  block: string | null;
  status: string;
}

const STATUS_COLOURS: Record<OrBoardCase["status"], string> = {
  scheduled: "bg-slate-100 text-slate-700",
  pre_op: "bg-amber-100 text-amber-800",
  in_progress: "bg-blue-100 text-blue-800",
  post_op: "bg-purple-100 text-purple-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-800",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0]!;
}

function PhaseDot({ done }: { done: boolean | null }) {
  if (done === null || done === undefined) {
    return <span className="inline-block w-2 h-2 rounded-full bg-slate-300" />;
  }
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        done ? "bg-emerald-500" : "bg-slate-300"
      }`}
    />
  );
}

function fmtTime(t: string | null): string {
  if (!t) return "—";
  return t.slice(0, 5);
}

export default function OrBoardPage() {
  const [date, setDate] = useState<string>(todayIso());
  const [room, setRoom] = useState<string>("");

  const { data: rooms = [] } = useQuery<OrRoom[]>({
    queryKey: ["theatre", "rooms"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/theatre/rooms");
      const arr = unwrap<OrRoom[]>(r);
      return Array.isArray(arr) ? arr : [];
    },
    staleTime: 5 * 60 * 1000, // rooms change rarely
  });

  const {
    data: board,
    error,
    isLoading,
    refetch,
    dataUpdatedAt,
  } = useQuery<OrBoardResponse>({
    queryKey: ["theatre", "board", { date, room }],
    queryFn: async () => {
      const params = new URLSearchParams({ date });
      if (room) params.set("ot_room", room);
      const r = await fetchAdminAPI<unknown>(
        `/theatre/board?${params.toString()}`,
      );
      return unwrap<OrBoardResponse>(r);
    },
    refetchInterval: 60_000,
  });

  // Group cases by room.
  const grouped = useMemo(() => {
    if (!board) return [] as Array<{ room: string; cases: OrBoardCase[] }>;
    const m = new Map<string, OrBoardCase[]>();
    for (const c of board.cases) {
      const key = c.ot_room || "Unassigned";
      const arr = m.get(key) ?? [];
      arr.push(c);
      m.set(key, arr);
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([roomKey, cases]) => ({ room: roomKey, cases }));
  }, [board]);

  const totals = useMemo(() => {
    if (!board) return null;
    const total = board.cases.length;
    const completed = board.cases.filter(
      (c) => c.status === "completed",
    ).length;
    const inProgress = board.cases.filter(
      (c) => c.status === "in_progress",
    ).length;
    const cancelled = board.cases.filter(
      (c) => c.status === "cancelled",
    ).length;
    const allPhasesDone = board.cases.filter(
      (c) => c.sign_in_complete && c.time_out_complete && c.sign_out_complete,
    ).length;
    const openComplications = board.cases.reduce(
      (acc, c) => acc + (c.open_complications || 0),
      0,
    );
    return {
      total,
      completed,
      inProgress,
      cancelled,
      allPhasesDone,
      openComplications,
    };
  }, [board]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">OR Board</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Today&apos;s surgical cases with checklist + WHO safety phase
            status. Auto-refreshes every 60s.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {dataUpdatedAt ? (
            <>Updated {new Date(dataUpdatedAt).toLocaleTimeString()}</>
          ) : (
            <>—</>
          )}
          <button
            onClick={() => refetch()}
            className="ml-3 px-3 py-1.5 rounded-md border text-foreground hover:bg-muted text-xs"
          >
            Refresh now
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Date
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Room
          </label>
          <select
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm min-w-[180px]"
          >
            <option value="">All rooms</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.code}>
                {r.code} — {r.display_name}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setDate(todayIso())}
          className="px-3 py-2 rounded-md border text-foreground hover:bg-muted text-sm"
        >
          Today
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load OR board"}
        </div>
      )}

      {/* Headline counts */}
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Cases", value: totals.total },
            { label: "Completed", value: totals.completed },
            { label: "In progress", value: totals.inProgress },
            { label: "All WHO phases done", value: totals.allPhasesDone },
            { label: "Cancelled", value: totals.cancelled },
            {
              label: "Open complications",
              value: totals.openComplications,
              alert: totals.openComplications > 0,
            },
          ].map((s) => (
            <div
              key={s.label}
              className={`bg-card rounded-lg border shadow-sm p-3 ${
                s.alert ? "border-rose-300" : ""
              }`}
            >
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p
                className={`text-xl font-semibold mt-1 ${
                  s.alert ? "text-rose-600" : ""
                }`}
              >
                {s.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Board */}
      {isLoading && !board ? (
        <LoadingSpinner />
      ) : board && board.cases.length === 0 ? (
        <EmptyState
          title="No cases"
          description={`No surgical cases scheduled for ${board.date}${room ? ` in ${room}` : ""}.`}
        />
      ) : board ? (
        <div className="space-y-4">
          {grouped.map(({ room: roomKey, cases }) => (
            <div
              key={roomKey}
              className="bg-card rounded-lg border shadow-sm overflow-hidden"
            >
              <div className="px-4 py-2 bg-muted border-b text-sm font-semibold">
                {roomKey}{" "}
                <span className="text-muted-foreground font-normal">
                  · {cases.length} case{cases.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="text-left border-b">
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">Procedure</th>
                      <th className="px-3 py-2 font-medium">Surgeon</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Pre-op</th>
                      <th
                        className="px-3 py-2 font-medium"
                        title="Sign-in / Time-out / Sign-out"
                      >
                        WHO phases
                      </th>
                      <th className="px-3 py-2 font-medium">Notes</th>
                      <th className="px-3 py-2 font-medium">Complications</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((c) => (
                      <tr
                        key={c.id}
                        className="border-b last:border-0 hover:bg-muted/50"
                      >
                        <td className="px-3 py-2 font-mono text-xs">
                          {fmtTime(c.scheduled_time)}
                          {c.estimated_duration ? (
                            <span className="text-muted-foreground">
                              {" "}
                              · {c.estimated_duration}m
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <div>{c.procedure_name}</div>
                          {c.procedure_code && (
                            <div className="text-xs text-muted-foreground font-mono">
                              {c.procedure_code}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground font-mono">
                          {c.surgeon.slice(0, 8)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              STATUS_COLOURS[c.status]
                            }`}
                          >
                            {c.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-2 text-xs">
                            <span
                              className={
                                c.consent_obtained
                                  ? "text-emerald-600"
                                  : "text-rose-600"
                              }
                              title="Consent obtained"
                            >
                              {c.consent_obtained ? "✓" : "✗"} consent
                            </span>
                            <span
                              className={
                                c.blood_arranged
                                  ? "text-emerald-600"
                                  : "text-slate-400"
                              }
                              title="Blood arranged"
                            >
                              {c.blood_arranged ? "✓" : "—"} blood
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div
                            className="flex gap-1 items-center"
                            title="Sign-in / Time-out / Sign-out"
                          >
                            <PhaseDot done={c.sign_in_complete} />
                            <PhaseDot done={c.time_out_complete} />
                            <PhaseDot done={c.sign_out_complete} />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {c.intraop_note_count} intra · {c.postop_note_count}{" "}
                          post
                        </td>
                        <td className="px-3 py-2">
                          {c.open_complications > 0 ? (
                            <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-rose-100 text-rose-800">
                              {c.open_complications} open
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
