// src/app/(with-auth)/dashboard/staff-roster/page.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { getStaffByShift, bulkShiftAssignment } from "@/lib/api/staff";
import { Spinner } from "@/components/ui/spinner";

/* ---------- Types ---------- */

interface StaffMember {
  id: number;
  name: string;
  role: string;
  department?: string;
  shift?: string;
}

interface ShiftData {
  [shift: string]: StaffMember[];
}

type ShiftType = "morning" | "afternoon" | "night";

const SHIFT_LABELS: Record<ShiftType, string> = {
  morning: "Morning (6–14)",
  afternoon: "Afternoon (14–22)",
  night: "Night (22–6)",
};

const SHIFT_COLORS: Record<ShiftType, string> = {
  morning: "#fef3c7",
  afternoon: "#dbeafe",
  night: "#ede9fe",
};

const SHIFT_BORDER: Record<ShiftType, string> = {
  morning: "#f59e0b",
  afternoon: "#3b82f6",
  night: "#8b5cf6",
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getWeekDates(offset: number): string[] {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7) + offset * 7);
  return DAYS.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/* ---------- Page ---------- */

export default function StaffRosterPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shiftData, setShiftData] = useState<ShiftData>({});
  const [weekOffset, setWeekOffset] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [assigning, setAssigning] = useState(false);

  // Modal state
  const [selectedStaffId, setSelectedStaffId] = useState<number | "">("");
  const [selectedShift, setSelectedShift] = useState<ShiftType>("morning");
  const [selectedDays, setSelectedDays] = useState<boolean[]>(DAYS.map(() => false));

  const weekDates = getWeekDates(weekOffset);
  const weekLabel = `${weekDates[0]} — ${weekDates[6]}`;

  const allStaff: StaffMember[] = Object.values(shiftData).flat();
  const uniqueStaff = Array.from(new Map(allStaff.map((s) => [s.id, s])).values());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [morning, afternoon, night] = await Promise.all([
        getStaffByShift<{ data: StaffMember[] }>("morning").catch(() => ({ data: [] as StaffMember[] })),
        getStaffByShift<{ data: StaffMember[] }>("afternoon").catch(() => ({ data: [] as StaffMember[] })),
        getStaffByShift<{ data: StaffMember[] }>("night").catch(() => ({ data: [] as StaffMember[] })),
      ]);
      setShiftData({
        morning: morning?.data ?? [],
        afternoon: afternoon?.data ?? [],
        night: night?.data ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load staff data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAssign = async () => {
    if (!selectedStaffId) return;
    const dates = weekDates.filter((_, i) => selectedDays[i]);
    if (dates.length === 0) return;

    try {
      setAssigning(true);
      await bulkShiftAssignment([
        { staffId: Number(selectedStaffId), shift: selectedShift, dates },
      ]);
      setShowModal(false);
      setSelectedDays(DAYS.map(() => false));
      await fetchData();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setAssigning(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--bg-secondary, #fff)",
    borderRadius: 12,
    padding: 24,
    border: "1px solid var(--border-color, #e2e8f0)",
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 256 }}>
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <p style={{ color: "var(--color-error, #ef4444)" }}>{error}</p>
        <button onClick={fetchData} style={{ marginTop: 12, padding: "8px 16px", cursor: "pointer" }}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 0 32px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Staff Roster</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setWeekOffset((w) => w - 1)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", cursor: "pointer" }}>← Prev</button>
          <span style={{ fontSize: 14, fontWeight: 500, minWidth: 200, textAlign: "center" }}>{weekLabel}</span>
          <button onClick={() => setWeekOffset((w) => w + 1)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", cursor: "pointer" }}>Next →</button>
          <button
            onClick={() => setShowModal(true)}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              background: "var(--color-primary, #3b82f6)",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Assign Shift
          </button>
        </div>
      </div>

      {/* Shift Legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
        {(Object.keys(SHIFT_LABELS) as ShiftType[]).map((s) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <div style={{ width: 14, height: 14, borderRadius: 3, background: SHIFT_COLORS[s], border: `2px solid ${SHIFT_BORDER[s]}` }} />
            {SHIFT_LABELS[s]}
          </div>
        ))}
      </div>

      {/* Shift Sections */}
      {(Object.keys(SHIFT_LABELS) as ShiftType[]).map((shift) => {
        const staff = shiftData[shift] ?? [];
        return (
          <div key={shift} style={{ ...cardStyle, marginBottom: 20 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: SHIFT_BORDER[shift] }}>
              {SHIFT_LABELS[shift]} — {staff.length} staff
            </h2>
            {staff.length === 0 ? (
              <p style={{ color: "var(--text-secondary, #888)", fontSize: 14 }}>No staff assigned</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border-color, #e2e8f0)", fontWeight: 600 }}>Staff</th>
                      <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border-color, #e2e8f0)", fontWeight: 600 }}>Role</th>
                      <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border-color, #e2e8f0)", fontWeight: 600 }}>Department</th>
                      {DAYS.map((d) => (
                        <th key={d} style={{ textAlign: "center", padding: "8px 6px", borderBottom: "1px solid var(--border-color, #e2e8f0)", fontWeight: 600 }}>{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((s) => (
                      <tr key={s.id}>
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-color, #f1f5f9)" }}>{s.name}</td>
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-color, #f1f5f9)" }}>{s.role}</td>
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-color, #f1f5f9)" }}>{s.department || "—"}</td>
                        {DAYS.map((d) => (
                          <td key={d} style={{ textAlign: "center", padding: "8px 6px", borderBottom: "1px solid var(--border-color, #f1f5f9)" }}>
                            <div style={{ width: 24, height: 24, borderRadius: 4, background: SHIFT_COLORS[shift], border: `1px solid ${SHIFT_BORDER[shift]}`, margin: "0 auto" }} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* Assign Shift Modal */}
      {showModal && (
        <>
          <div onClick={() => setShowModal(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 51, background: "var(--bg-secondary, #fff)", borderRadius: 12, padding: 24, width: 420, maxWidth: "90vw", boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)" }}>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Assign Shift</h3>

            <label style={{ display: "block", marginBottom: 12, fontSize: 14 }}>
              Staff Member
              <select
                value={selectedStaffId}
                onChange={(e) => setSelectedStaffId(e.target.value ? Number(e.target.value) : "")}
                style={{ display: "block", width: "100%", padding: "8px 12px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}
              >
                <option value="">Select staff...</option>
                {uniqueStaff.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
                ))}
              </select>
            </label>

            <label style={{ display: "block", marginBottom: 12, fontSize: 14 }}>
              Shift
              <select
                value={selectedShift}
                onChange={(e) => setSelectedShift(e.target.value as ShiftType)}
                style={{ display: "block", width: "100%", padding: "8px 12px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)" }}
              >
                {(Object.keys(SHIFT_LABELS) as ShiftType[]).map((s) => (
                  <option key={s} value={s}>{SHIFT_LABELS[s]}</option>
                ))}
              </select>
            </label>

            <fieldset style={{ marginBottom: 16, border: "none", padding: 0 }}>
              <legend style={{ fontSize: 14, marginBottom: 8 }}>Days</legend>
              <div style={{ display: "flex", gap: 8 }}>
                {DAYS.map((d, i) => (
                  <label key={d} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={selectedDays[i]}
                      onChange={() => setSelectedDays((prev) => prev.map((v, j) => (j === i ? !v : v)))}
                    />
                    {d}
                  </label>
                ))}
              </div>
            </fieldset>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowModal(false)} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", cursor: "pointer", background: "transparent" }}>
                Cancel
              </button>
              <button
                onClick={handleAssign}
                disabled={assigning || !selectedStaffId || !selectedDays.some(Boolean)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  background: "var(--color-primary, #3b82f6)",
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: 500,
                  opacity: assigning ? 0.6 : 1,
                }}
              >
                {assigning ? "Assigning..." : "Assign"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
