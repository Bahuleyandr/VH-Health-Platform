// src/app/(with-auth)/dashboard/beds/page.tsx
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchAdminAPI } from "@/lib/api";

/* ---------- Types ---------- */

type BedStatus = "available" | "occupied" | "reserved" | "maintenance";

interface Bed {
  id: number;
  bed_number: string;
  status: BedStatus;
  ward_id: number;
  ward_name?: string | null;
  ward_floor?: number | null;
  patient_name?: string | null;
  patient_uid?: string | null;
}

interface Ward {
  id: number;
  name: string;
  floor: number | null;
  total_beds?: number;
}

const STATUS_COLORS: Record<BedStatus, { bg: string; border: string; text: string }> = {
  available: { bg: "#dcfce7", border: "#22c55e", text: "#16a34a" },
  occupied: { bg: "#fef2f2", border: "#ef4444", text: "#dc2626" },
  reserved: { bg: "#fef3c7", border: "#f59e0b", text: "#d97706" },
  maintenance: { bg: "#f1f5f9", border: "#94a3b8", text: "#64748b" },
};

/* ---------- Page ---------- */

export default function BedsPage() {
  const qc = useQueryClient();
  const [filterWard, setFilterWard] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [editBed, setEditBed] = useState<Bed | null>(null);

  const bedsQuery = useQuery<Bed[]>({
    queryKey: ["beds"],
    queryFn: async () => {
      const res = await fetchAdminAPI<Bed[] | { rows: Bed[] }>("/beds");
      // fetchAdminAPI unwraps data; backend returns either array or { rows: [] }.
      if (Array.isArray(res)) return res;
      if (Array.isArray((res as { rows?: Bed[] })?.rows)) return (res as { rows: Bed[] }).rows;
      return [] as Bed[];
    },
    refetchOnWindowFocus: false,
  });

  const wardsQuery = useQuery<Ward[]>({
    queryKey: ["wards"],
    queryFn: async () => {
      const res = await fetchAdminAPI<Ward[] | { rows: Ward[] }>("/wards");
      if (Array.isArray(res)) return res;
      if (Array.isArray((res as { rows?: Ward[] })?.rows)) return (res as { rows: Ward[] }).rows;
      return [] as Ward[];
    },
    refetchOnWindowFocus: false,
  });

  const updateStatusMutation = useMutation({
    mutationFn: async (payload: { id: number; status: BedStatus; patient_name?: string | null }) => {
      return fetchAdminAPI(`/beds/${payload.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: payload.status, patient_name: payload.patient_name ?? null }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["beds"] }),
  });

  const beds = bedsQuery.data ?? [];
  const wards = wardsQuery.data ?? [];

  const filtered = useMemo(() => beds.filter((b) => {
    if (filterWard !== "all" && String(b.ward_id) !== filterWard) return false;
    if (filterStatus !== "all" && b.status !== filterStatus) return false;
    return true;
  }), [beds, filterWard, filterStatus]);

  const total = beds.length;
  const occupied = beds.filter((b) => b.status === "occupied").length;
  const available = beds.filter((b) => b.status === "available").length;
  const reserved = beds.filter((b) => b.status === "reserved").length;
  const maintenance = beds.filter((b) => b.status === "maintenance").length;

  const cardStyle: React.CSSProperties = {
    background: "var(--bg-secondary, #fff)",
    borderRadius: 12,
    padding: 24,
    border: "1px solid var(--border-color, #e2e8f0)",
  };

  const summaryTiles = [
    { label: "Total", value: total, color: "#3b82f6" },
    { label: "Available", value: available, color: "#22c55e" },
    { label: "Occupied", value: occupied, color: "#ef4444" },
    { label: "Reserved", value: reserved, color: "#f59e0b" },
    { label: "Maintenance", value: maintenance, color: "#94a3b8" },
  ];

  return (
    <div style={{ padding: "0 0 32px" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Bed / Ward Management</h1>

      {bedsQuery.isError && (
        <div style={{ background: "#fef2f2", border: "1px solid #ef4444", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 14, color: "#dc2626" }}>
          Failed to load beds from the backend.
          <button
            onClick={() => { bedsQuery.refetch(); wardsQuery.refetch(); }}
            style={{ marginLeft: 12, padding: "4px 10px", borderRadius: 6, background: "#fff", border: "1px solid #ef4444", color: "#dc2626", cursor: "pointer" }}
          >Retry</button>
        </div>
      )}

      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
        {summaryTiles.map((s) => (
          <div key={s.label} style={{ ...cardStyle, padding: 16, textAlign: "center" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>
              {bedsQuery.isLoading ? "…" : s.value}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <select value={filterWard} onChange={(e) => setFilterWard(e.target.value)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}>
          <option value="all">All Wards</option>
          {wards.map((w) => <option key={w.id} value={String(w.id)}>{w.name}{w.floor != null ? ` (Floor ${w.floor})` : ""}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}>
          <option value="all">All Status</option>
          <option value="available">Available</option>
          <option value="occupied">Occupied</option>
          <option value="reserved">Reserved</option>
          <option value="maintenance">Maintenance</option>
        </select>
      </div>

      {/* Bed Grid */}
      {bedsQuery.isLoading ? (
        <div style={{ padding: 48, textAlign: "center", color: "var(--text-secondary, #888)" }}>Loading beds…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "var(--text-secondary, #888)" }}>
          No beds match the current filters.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
          {filtered.map((bed) => {
            const sc = STATUS_COLORS[bed.status];
            return (
              <div
                key={bed.id}
                onClick={() => setEditBed(bed)}
                style={{
                  padding: 14,
                  borderRadius: 8,
                  border: `2px solid ${sc.border}`,
                  background: sc.bg,
                  cursor: "pointer",
                  transition: "transform 0.15s",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 16 }}>{bed.bed_number}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: sc.text, textTransform: "uppercase" }}>{bed.status}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary, #666)" }}>
                  {bed.ward_name ?? `Ward ${bed.ward_id}`}
                  {bed.ward_floor != null ? ` · Floor ${bed.ward_floor}` : ""}
                </div>
                {bed.patient_name && (
                  <div style={{ fontSize: 12, marginTop: 4, fontWeight: 500 }}>🛏️ {bed.patient_name}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit Modal */}
      {editBed && (
        <>
          <div onClick={() => setEditBed(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 51, background: "var(--bg-secondary, #fff)", borderRadius: 12, padding: 24, width: 360, maxWidth: "90vw", boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)" }}>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Bed {editBed.bed_number}</h3>

            <label style={{ display: "block", marginBottom: 12, fontSize: 14 }}>
              Status
              <select
                value={editBed.status}
                onChange={(e) => {
                  const status = e.target.value as BedStatus;
                  const updated = { ...editBed, status, patient_name: status !== "occupied" ? null : editBed.patient_name };
                  setEditBed(updated);
                }}
                style={{ display: "block", width: "100%", padding: "8px 12px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}
              >
                <option value="available">Available</option>
                <option value="occupied">Occupied</option>
                <option value="reserved">Reserved</option>
                <option value="maintenance">Maintenance</option>
              </select>
            </label>

            {editBed.status === "occupied" && (
              <label style={{ display: "block", marginBottom: 12, fontSize: 14 }}>
                Patient Name
                <input
                  value={editBed.patient_name || ""}
                  onChange={(e) => setEditBed({ ...editBed, patient_name: e.target.value })}
                  style={{ display: "block", width: "100%", padding: "8px 12px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}
                  placeholder="Patient name"
                />
              </label>
            )}

            {updateStatusMutation.isError && (
              <div style={{ fontSize: 13, color: "#dc2626", marginBottom: 8 }}>
                Failed to save. Please try again.
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setEditBed(null)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", cursor: "pointer", background: "transparent" }}>
                Cancel
              </button>
              <button
                disabled={updateStatusMutation.isPending}
                onClick={async () => {
                  try {
                    await updateStatusMutation.mutateAsync({
                      id: editBed.id,
                      status: editBed.status,
                      patient_name: editBed.status === "occupied" ? editBed.patient_name ?? null : null,
                    });
                    setEditBed(null);
                  } catch {
                    /* mutation error already surfaced inline */
                  }
                }}
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--color-primary, #3b82f6)", color: "#fff", border: "none", cursor: updateStatusMutation.isPending ? "wait" : "pointer", fontWeight: 500, opacity: updateStatusMutation.isPending ? 0.7 : 1 }}
              >
                {updateStatusMutation.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
