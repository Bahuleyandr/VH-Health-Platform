// src/app/(with-auth)/dashboard/beds/page.tsx
//
// Sprint 12 — Bed management board. Backend (services/bed/*) was
// already complete; this is the admin grid that wires up the
// occupancy stats + a per-bed grid coloured by status, with the
// admit / discharge / transfer / mark-ready actions inline.

"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";

interface Bed {
  id: number;
  ward_id: number | null;
  ward_name: string | null;
  floor: number | null;
  bed_number: string;
  bed_type: string | null;
  status: "available" | "occupied" | "reserved" | "maintenance" | "cleaning";
  patient_uid: string | null;
  patient_name: string | null;
  admitted_at: string | null;
  expected_discharge: string | null;
  notes: string | null;
}

interface OccupancySummary {
  overall: {
    total: number;
    occupied: number;
    available: number;
    reserved: number;
    maintenance: number;
    cleaning: number;
    occupancy_rate: number;
  };
  by_ward: Array<{
    ward_id: number | null;
    ward_name: string | null;
    floor: number | null;
    total: number;
    occupied: number;
    available: number;
  }>;
  by_type: Array<{
    bed_type: string;
    total: number;
    occupied: number;
    available: number;
  }>;
}

const STATUS_COLOURS: Record<string, string> = {
  available: "bg-emerald-100 text-emerald-800 border-emerald-300",
  occupied: "bg-blue-100 text-blue-800 border-blue-300",
  reserved: "bg-amber-100 text-amber-800 border-amber-300",
  cleaning: "bg-purple-100 text-purple-800 border-purple-300",
  maintenance: "bg-rose-100 text-rose-800 border-rose-300",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function unwrapList<T>(r: unknown, key: string): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  if (Array.isArray(data)) return data as T[];
  const inner = (data as Record<string, unknown>)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

function fmtAge(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s).getTime();
  const h = (Date.now() - d) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

export default function BedsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [wardFilter, setWardFilter] = useState<string>("");

  const { data: occupancy, error: occErr, isLoading: occLoading } =
    useQuery<OccupancySummary>({
      queryKey: ["beds", "occupancy"],
      queryFn: async () => {
        const r = await fetchAdminAPI<unknown>("/beds/occupancy");
        return unwrap<OccupancySummary>(r);
      },
      refetchInterval: 60_000,
    });

  const { data: beds = [], error: bedsErr, isLoading: bedsLoading } =
    useQuery<Bed[]>({
      queryKey: ["beds", "list"],
      queryFn: async () => {
        const r = await fetchAdminAPI<unknown>("/beds");
        return unwrapList<Bed>(r, "rows");
      },
      refetchInterval: 60_000,
    });

  const admitMut = useMutation({
    mutationFn: async (vars: { bedId: number; patient_uid: string; expected_discharge?: string }) =>
      fetchAdminAPI(`/beds/${vars.bedId}/admit`, {
        method: "POST",
        body: JSON.stringify({
          patient_uid: vars.patient_uid,
          expected_discharge: vars.expected_discharge ?? null,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["beds"] }),
  });

  const dischargeMut = useMutation({
    mutationFn: async (bedId: number) =>
      fetchAdminAPI(`/beds/${bedId}/discharge`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["beds"] }),
  });

  const readyMut = useMutation({
    mutationFn: async (bedId: number) =>
      fetchAdminAPI(`/beds/${bedId}/ready`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["beds"] }),
  });

  const transferMut = useMutation({
    mutationFn: async (vars: { patient_uid: string; to_bed_id: number; reason?: string }) =>
      fetchAdminAPI(`/beds/transfer`, {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["beds"] }),
  });

  function admit(bed: Bed) {
    const uid = window.prompt(`Admit to ${bed.bed_number} — patient UID:`, "");
    if (!uid) return;
    const eta = window.prompt(`Expected discharge (YYYY-MM-DD, optional):`, "");
    admitMut.mutate({
      bedId: bed.id,
      patient_uid: uid,
      expected_discharge: eta || undefined,
    });
  }

  function discharge(bed: Bed) {
    if (!window.confirm(`Discharge patient from ${bed.bed_number}? Bed will go to cleaning.`)) return;
    dischargeMut.mutate(bed.id);
  }

  function markReady(bed: Bed) {
    readyMut.mutate(bed.id);
  }

  function transfer(bed: Bed) {
    if (!bed.patient_uid) return;
    const toBedStr = window.prompt(
      `Transfer ${bed.patient_name ?? bed.patient_uid.slice(0, 8)} from ${bed.bed_number} to bed id:`,
      "",
    );
    if (!toBedStr) return;
    const toBedId = Number(toBedStr);
    if (!Number.isFinite(toBedId)) return;
    const reason = window.prompt(`Transfer reason:`, "") ?? undefined;
    transferMut.mutate({
      patient_uid: bed.patient_uid,
      to_bed_id: toBedId,
      reason,
    });
  }

  const visibleBeds = beds.filter((b) => {
    if (statusFilter && b.status !== statusFilter) return false;
    if (wardFilter && String(b.ward_id ?? "") !== wardFilter) return false;
    return true;
  });

  const grouped = new Map<string, Bed[]>();
  for (const b of visibleBeds) {
    const k = b.ward_name ?? "Unassigned";
    const list = grouped.get(k) ?? [];
    list.push(b);
    grouped.set(k, list);
  }

  const errMsg = (
    occErr ?? bedsErr ?? admitMut.error ?? dischargeMut.error ?? readyMut.error ?? transferMut.error
  )?.toString();
  const busy =
    admitMut.isPending || dischargeMut.isPending || readyMut.isPending || transferMut.isPending;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Bed Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Occupancy grid + admit / discharge / transfer flow. Auto-refreshes every 60s.
          </p>
        </div>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["beds"] })}
          className="px-3 py-1.5 rounded-md border text-foreground hover:bg-muted text-xs"
        >
          Refresh now
        </button>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {occLoading && !occupancy ? (
        <LoadingSpinner />
      ) : occupancy ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label="Total beds" value={occupancy.overall.total} />
            <MetricCard
              label="Occupancy"
              value={`${occupancy.overall.occupancy_rate}%`}
              help={`${occupancy.overall.occupied}/${occupancy.overall.total}`}
            />
            <MetricCard label="Available" value={occupancy.overall.available} />
            <MetricCard label="Cleaning" value={occupancy.overall.cleaning} />
            <MetricCard label="Reserved" value={occupancy.overall.reserved} />
            <MetricCard
              label="Maintenance"
              value={occupancy.overall.maintenance}
            />
          </div>

          {occupancy.by_ward.length > 0 && (
            <section>
              <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                By ward
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {occupancy.by_ward.map((w, i) => (
                  <div
                    key={`${w.ward_id ?? "x"}-${i}`}
                    className="bg-white rounded-lg border shadow-sm p-3"
                  >
                    <p className="text-sm font-medium">
                      {w.ward_name ?? "Unassigned"}
                      {w.floor != null && (
                        <span className="text-muted-foreground"> · F{w.floor}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {w.occupied}/{w.total} occupied · {w.available} available
                    </p>
                    <div className="mt-2 bg-muted rounded h-2 overflow-hidden">
                      <div
                        className="bg-blue-500 h-full"
                        style={{
                          width: `${w.total > 0 ? (w.occupied / w.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : null}

      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {["available", "occupied", "reserved", "cleaning", "maintenance"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Ward</label>
          <select
            value={wardFilter}
            onChange={(e) => setWardFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm min-w-[180px]"
          >
            <option value="">All wards</option>
            {(occupancy?.by_ward ?? []).map((w, i) => (
              <option
                key={`${w.ward_id ?? "x"}-${i}`}
                value={String(w.ward_id ?? "")}
              >
                {w.ward_name ?? "Unassigned"}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          Showing {visibleBeds.length} bed{visibleBeds.length === 1 ? "" : "s"}
        </p>
      </div>

      {bedsLoading && beds.length === 0 ? (
        <LoadingSpinner />
      ) : visibleBeds.length === 0 ? (
        <EmptyState title="No beds" description="No beds match these filters." />
      ) : (
        <div className="space-y-4">
          {Array.from(grouped.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ward, wardBeds]) => (
              <section
                key={ward}
                className="bg-white rounded-lg border shadow-sm overflow-hidden"
              >
                <div className="px-4 py-2 bg-muted border-b text-sm font-semibold">
                  {ward} · {wardBeds.length} bed{wardBeds.length === 1 ? "" : "s"}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 p-3">
                  {wardBeds.map((bed) => (
                    <BedTile
                      key={bed.id}
                      bed={bed}
                      busy={busy}
                      onAdmit={() => admit(bed)}
                      onDischarge={() => discharge(bed)}
                      onMarkReady={() => markReady(bed)}
                      onTransfer={() => transfer(bed)}
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}

function BedTile({
  bed,
  busy,
  onAdmit,
  onDischarge,
  onMarkReady,
  onTransfer,
}: {
  bed: Bed;
  busy: boolean;
  onAdmit: () => void;
  onDischarge: () => void;
  onMarkReady: () => void;
  onTransfer: () => void;
}) {
  return (
    <div className={`rounded border-2 p-2 text-xs ${STATUS_COLOURS[bed.status]}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono font-bold">{bed.bed_number}</span>
        <span className="text-[10px] uppercase tracking-wider">{bed.status}</span>
      </div>
      <p className="text-[10px] text-muted-foreground mt-0.5">
        {bed.bed_type ?? "general"}
      </p>
      {bed.patient_uid && (
        <div className="mt-2 truncate">
          <p className="font-medium truncate">
            {bed.patient_name ?? bed.patient_uid.slice(0, 8)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {fmtAge(bed.admitted_at)} on bed
          </p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {bed.status === "available" && (
          <button
            onClick={onAdmit}
            disabled={busy}
            className="px-1.5 py-0.5 rounded bg-blue-600 text-white disabled:opacity-40"
          >
            Admit
          </button>
        )}
        {bed.status === "occupied" && (
          <>
            <button
              onClick={onTransfer}
              disabled={busy}
              className="px-1.5 py-0.5 rounded bg-amber-600 text-white disabled:opacity-40"
            >
              Transfer
            </button>
            <button
              onClick={onDischarge}
              disabled={busy}
              className="px-1.5 py-0.5 rounded bg-rose-600 text-white disabled:opacity-40"
            >
              Discharge
            </button>
          </>
        )}
        {bed.status === "cleaning" && (
          <button
            onClick={onMarkReady}
            disabled={busy}
            className="px-1.5 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40"
          >
            Ready
          </button>
        )}
      </div>
    </div>
  );
}
