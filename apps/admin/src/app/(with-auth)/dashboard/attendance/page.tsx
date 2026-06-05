// src/app/(with-auth)/dashboard/attendance/page.tsx
"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { ManagedTableToolbar } from "@/components/table";
import { adminService } from "@/services/admin.service";

// Types
type AttendanceRecord = {
  staff_id?: number;
  staff_name?: string;
  name?: string;
  department?: string;
  status?: string;
  check_in_time?: string;
  check_out_time?: string;
  hours_worked?: number;
  is_late?: boolean;
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function unwrapData<T>(x: unknown): T | null {
  if (x && typeof x === "object" && "data" in x) {
    return (x as { data?: T }).data ?? null;
  }
  return (x as T) ?? null;
}

function unwrapList(x: unknown): AttendanceRecord[] {
  const data = unwrapData<
    | AttendanceRecord[]
    | { records?: AttendanceRecord[]; staff?: AttendanceRecord[] }
  >(x);
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const arr = obj.records ?? obj.staff ?? obj.absent ?? obj.data;
    if (Array.isArray(arr)) return arr as AttendanceRecord[];
  }
  return [];
}

type StatusBadgeProps = { status: string };
function StatusBadge({ status }: StatusBadgeProps) {
  const s = (status ?? "").toLowerCase();
  const cls =
    s === "present" || s === "checked-in"
      ? "bg-green-100 text-green-700 border border-green-300"
      : s === "absent"
        ? "bg-red-100 text-red-700 border border-red-300"
        : s === "late"
          ? "bg-orange-100 text-orange-700 border border-orange-300"
          : s === "leave"
            ? "bg-blue-100 text-blue-700 border border-blue-300"
            : "bg-gray-100 text-gray-600 border border-gray-300";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {status?.toUpperCase() ?? "—"}
    </span>
  );
}

type StatCardProps = {
  label: string;
  value: number | string;
  color: string;
  icon: string;
};
function StatCard({ label, value, color, icon }: StatCardProps) {
  return (
    <div
      className={`rounded-xl border p-4 flex items-center gap-4 bg-card shadow-sm`}
    >
      <span className={`text-3xl`}>{icon}</span>
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold ${color}`}>{value}</p>
      </div>
    </div>
  );
}

export default function AttendancePage() {
  const [analytics, setAnalytics] = useState<Json>(null);
  const [absentList, setAbsentList] = useState<AttendanceRecord[]>([]);
  const [lateList, setLateList] = useState<AttendanceRecord[]>([]);
  const [anomalies, setAnomalies] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [department, setDepartment] = useState("");
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().slice(0, 10),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, an, ab, late] = await Promise.allSettled([
        adminService.getAttendanceAnalytics({ group_by: "day" }),
        adminService.getAttendanceAnomalies(),
        adminService.getAbsentReport({
          date: selectedDate,
          department: department || null,
        }),
        adminService.getLateArrivals({
          date: selectedDate,
          department: department || null,
        }),
      ]);

      if (a.status === "fulfilled") {
        const d = unwrapData<Json>(a.value);
        setAnalytics(d);
      }
      if (an.status === "fulfilled") setAnomalies(unwrapList(an.value));
      if (ab.status === "fulfilled") setAbsentList(unwrapList(ab.value));
      if (late.status === "fulfilled") setLateList(unwrapList(late.value));
    } finally {
      setLoading(false);
    }
  }, [selectedDate, department]);

  useEffect(() => {
    load();
  }, [load]);

  // Derive stats from analytics or fallback to list counts
  const analyticsObj =
    analytics && typeof analytics === "object" && !Array.isArray(analytics)
      ? (analytics as Record<string, Json>)
      : null;

  const presentCount = (analyticsObj?.present as number) ?? 0;
  const absentCount = (analyticsObj?.absent as number) ?? absentList.length;
  const leaveCount = (analyticsObj?.leave as number) ?? 0;
  const lateCount = (analyticsObj?.late as number) ?? lateList.length;

  const departments = [
    "",
    "Nursing",
    "Pharmacy",
    "Administration",
    "Lab",
    "Radiology",
    "OT",
    "ICU",
  ];
  const matchesSearch = useCallback(
    (record: AttendanceRecord) => {
      const term = search.trim().toLowerCase();
      if (!term) return true;
      return [
        record.staff_name,
        record.name,
        record.department,
        record.status,
        record.staff_id,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    },
    [search],
  );
  const visibleAbsent = useMemo(
    () => absentList.filter(matchesSearch),
    [absentList, matchesSearch],
  );
  const visibleLate = useMemo(
    () => lateList.filter(matchesSearch),
    [lateList, matchesSearch],
  );
  const visibleAnomalies = useMemo(
    () => anomalies.filter(matchesSearch),
    [anomalies, matchesSearch],
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Staff Attendance</h1>
        <button
          onClick={load}
          className="text-sm px-3 py-1.5 rounded-lg border hover:bg-muted transition-colors"
        >
          🔄 Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        />
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          {departments.map((d) => (
            <option key={d} value={d}>
              {d || "All Departments"}
            </option>
          ))}
        </select>
      </div>

      <ManagedTableToolbar
        search={search}
        onSearchChange={setSearch}
        placeholder="Search staff, department, status"
        countLabel={`${visibleAbsent.length + visibleLate.length + visibleAnomalies.length} matching rows`}
        savedViewScope="attendance"
        savedViewState={{ search, department, selectedDate }}
        onApplySavedView={(view) => {
          setSearch(String(view.search ?? ""));
          setDepartment(String(view.department ?? ""));
          const date = String(view.selectedDate ?? "");
          if (date) setSelectedDate(date);
        }}
      />

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Present Today"
              value={presentCount}
              color="text-green-600"
              icon="✅"
            />
            <StatCard
              label="Absent"
              value={absentCount}
              color="text-red-600"
              icon="❌"
            />
            <StatCard
              label="On Leave"
              value={leaveCount}
              color="text-blue-600"
              icon="🏖️"
            />
            <StatCard
              label="Late Arrivals"
              value={lateCount}
              color="text-orange-600"
              icon="⏰"
            />
          </div>

          {/* Absent Staff */}
          <section>
            <h2 className="text-lg font-semibold mb-3">
              Absent Staff — {selectedDate}
            </h2>
            {visibleAbsent.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No absent staff for this date.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
                <table className="min-w-[620px] w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Name</th>
                      <th className="text-left px-4 py-3 font-medium">
                        Department
                      </th>
                      <th className="text-left px-4 py-3 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {visibleAbsent.map((r) => (
                      <tr
                        key={`${r.staff_id ?? r.staff_name ?? r.name}-absent`}
                        className="hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          {r.staff_name ?? r.name ?? `Staff #${r.staff_id}`}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {r.department ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={r.status ?? "absent"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Late Arrivals */}
          {visibleLate.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold mb-3">
                Late Arrivals — {selectedDate}
              </h2>
              <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
                <table className="min-w-[720px] w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Name</th>
                      <th className="text-left px-4 py-3 font-medium">
                        Department
                      </th>
                      <th className="text-left px-4 py-3 font-medium">
                        Check-in
                      </th>
                      <th className="text-left px-4 py-3 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {visibleLate.map((r) => (
                      <tr
                        key={`${r.staff_id ?? r.staff_name ?? r.name}-late`}
                        className="hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          {r.staff_name ?? r.name ?? `Staff #${r.staff_id}`}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {r.department ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {r.check_in_time
                            ? new Date(r.check_in_time).toLocaleTimeString(
                                "en-IN",
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )
                            : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status="late" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Anomalies */}
          {visibleAnomalies.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold mb-3">
                Anomalies (Last 30 days)
              </h2>
              <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
                <table className="min-w-[620px] w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Name</th>
                      <th className="text-left px-4 py-3 font-medium">
                        Department
                      </th>
                      <th className="text-left px-4 py-3 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {visibleAnomalies.map((r) => (
                      <tr
                        key={`${r.staff_id ?? r.staff_name ?? r.name}-anomaly`}
                        className="hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          {r.staff_name ?? r.name ?? `Staff #${r.staff_id}`}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {r.department ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={r.status ?? "anomaly"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
