// src/app/(with-auth)/dashboard/beds/page.tsx
"use client";

import { useState, useEffect, useCallback } from "react";

/* ---------- Types ---------- */

type BedStatus = "available" | "occupied" | "reserved" | "maintenance";

interface Bed {
  id: string;
  number: string;
  ward: string;
  floor: number;
  status: BedStatus;
  patientName?: string;
}

const STATUS_COLORS: Record<BedStatus, { bg: string; border: string; text: string }> = {
  available: { bg: "#dcfce7", border: "#22c55e", text: "#16a34a" },
  occupied: { bg: "#fef2f2", border: "#ef4444", text: "#dc2626" },
  reserved: { bg: "#fef3c7", border: "#f59e0b", text: "#d97706" },
  maintenance: { bg: "#f1f5f9", border: "#94a3b8", text: "#64748b" },
};

const DEFAULT_WARDS = ["General", "ICU", "Pediatrics", "Maternity", "Surgical"];
const STORAGE_KEY = "vhhealth_beds";

function generateDefaultBeds(): Bed[] {
  const beds: Bed[] = [];
  let id = 1;
  for (const ward of DEFAULT_WARDS) {
    const floor = DEFAULT_WARDS.indexOf(ward) + 1;
    for (let i = 1; i <= 8; i++) {
      beds.push({
        id: String(id++),
        number: `${ward.charAt(0)}${floor}${String(i).padStart(2, "0")}`,
        ward,
        floor,
        status: "available",
      });
    }
  }
  return beds;
}

function loadBeds(): Bed[] {
  if (typeof window === "undefined") return generateDefaultBeds();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Bed[];
  } catch { /* ignore */ }
  const beds = generateDefaultBeds();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(beds));
  return beds;
}

function saveBeds(beds: Bed[]) {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(beds));
  }
}

/* ---------- Page ---------- */

export default function BedsPage() {
  const [beds, setBeds] = useState<Bed[]>([]);
  const [filterWard, setFilterWard] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [editBed, setEditBed] = useState<Bed | null>(null);

  useEffect(() => {
    setBeds(loadBeds());
  }, []);

  const updateBed = useCallback((id: string, updates: Partial<Bed>) => {
    setBeds((prev) => {
      const next = prev.map((b) => (b.id === id ? { ...b, ...updates } : b));
      saveBeds(next);
      return next;
    });
  }, []);

  const filtered = beds.filter((b) => {
    if (filterWard !== "all" && b.ward !== filterWard) return false;
    if (filterStatus !== "all" && b.status !== filterStatus) return false;
    return true;
  });

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

  return (
    <div style={{ padding: "0 0 32px" }}>
      {/* Banner */}
      <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 14, color: "#92400e" }}>
        ⚠️ Backend bed management API coming soon. Data is stored locally in your browser.
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Bed / Ward Management</h1>

      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Total", value: total, color: "#3b82f6" },
          { label: "Available", value: available, color: "#22c55e" },
          { label: "Occupied", value: occupied, color: "#ef4444" },
          { label: "Reserved", value: reserved, color: "#f59e0b" },
          { label: "Maintenance", value: maintenance, color: "#94a3b8" },
        ].map((s) => (
          <div key={s.label} style={{ ...cardStyle, padding: 16, textAlign: "center" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <select value={filterWard} onChange={(e) => setFilterWard(e.target.value)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}>
          <option value="all">All Wards</option>
          {DEFAULT_WARDS.map((w) => <option key={w} value={w}>{w}</option>)}
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
                <span style={{ fontWeight: 700, fontSize: 16 }}>{bed.number}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: sc.text, textTransform: "uppercase" }}>{bed.status}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary, #666)" }}>{bed.ward} · Floor {bed.floor}</div>
              {bed.patientName && (
                <div style={{ fontSize: 12, marginTop: 4, fontWeight: 500 }}>🛏️ {bed.patientName}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Edit Modal */}
      {editBed && (
        <>
          <div onClick={() => setEditBed(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 51, background: "var(--bg-secondary, #fff)", borderRadius: 12, padding: 24, width: 360, maxWidth: "90vw", boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)" }}>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Bed {editBed.number}</h3>

            <label style={{ display: "block", marginBottom: 12, fontSize: 14 }}>
              Status
              <select
                value={editBed.status}
                onChange={(e) => {
                  const status = e.target.value as BedStatus;
                  const updated = { ...editBed, status, patientName: status !== "occupied" ? undefined : editBed.patientName };
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
                  value={editBed.patientName || ""}
                  onChange={(e) => setEditBed({ ...editBed, patientName: e.target.value })}
                  style={{ display: "block", width: "100%", padding: "8px 12px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}
                  placeholder="Patient name"
                />
              </label>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setEditBed(null)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", cursor: "pointer", background: "transparent" }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  updateBed(editBed.id, { status: editBed.status, patientName: editBed.patientName });
                  setEditBed(null);
                }}
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--color-primary, #3b82f6)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 500 }}
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
