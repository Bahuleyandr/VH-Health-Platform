"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Calendar,
  Clock,
  Users,
  AlertTriangle,
  MapPin,
  CheckCircle,
  XCircle,
  Shield,
  Activity,
  TrendingUp,
} from "lucide-react";
import { getJSON } from "@/lib/api/core";
import { Skeleton } from "@/components/ui";

// ─── Types ────────────────────────────────────────────────────────────────────
interface AttendanceDashboardData {
  leave: Record<string, number | string | null>;
  regularization: Record<string, number | string | null>;
  disputes: Record<string, number | string | null>;
  overtime: Record<string, number | string | null>;
  geofence: Record<string, number | string | null>;
  overdue_items: OverdueItem[];
}

interface OverdueItem {
  type: string;
  id: number;
  staff_id: number;
  subject: string;
  created_at: string;
  hours_pending: number;
}

interface ActorRow {
  id: number;
  name: string;
  role: string;
  leave: number;
  regularization: number;
  disputes: number;
  overtime: number;
  last_action: string | null;
}

interface HRActivityData {
  period_days: number;
  actors: ActorRow[];
  bulk_corrections: Array<Record<string, unknown>>;
  leave_detail: Array<Record<string, unknown>>;
}

interface SLARow {
  total: number;
  actioned: number;
  overdue: number;
  within_sla: number;
  avg_hours: number | null;
  sla_hours: number;
  label: string;
}

interface SLAData {
  leave: SLARow;
  regularization: SLARow;
  disputes: SLARow;
  overtime: SLARow;
}

interface GeofenceData {
  breaches: GeofenceBreach[];
  stats: Record<string, number>;
  frequent_offenders: Array<{
    name: string;
    department: string;
    breach_count: number;
    last_breach: string;
  }>;
}

interface GeofenceBreach {
  id: number;
  staff_name: string;
  department: string;
  action: string;
  distance_meters: number | null;
  occurred_at: string;
  alerted: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function hoursAgo(iso: string) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function formatH(h: number | null) {
  if (!h) return "—";
  if (h < 24) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function typeColor(t: string) {
  const m: Record<string, string> = {
    leave: "bg-blue-100 text-blue-700",
    regularization: "bg-orange-100 text-orange-700",
    dispute: "bg-red-100 text-red-700",
    overtime: "bg-purple-100 text-purple-700",
  };
  return m[t] ?? "bg-gray-100 text-gray-600";
}

type Tab = "overview" | "hr-activity" | "sla" | "geofence";

export default function AttendanceAuditPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState(30);

  const dashQuery = useQuery<AttendanceDashboardData>({
    queryKey: ["attendance-audit-dashboard"],
    queryFn: async () => {
      const r = await getJSON<unknown>(
        "/api/v1/staff/admin/audit/attendance/dashboard",
      );
      return ((r as { data?: AttendanceDashboardData }).data ??
        r) as AttendanceDashboardData;
    },
    refetchInterval: 60000,
  });

  const activityQuery = useQuery<HRActivityData>({
    queryKey: ["attendance-hr-activity", days],
    queryFn: async () => {
      const r = await getJSON<unknown>(
        `/api/v1/staff/admin/audit/attendance/hr-activity?days=${days}`,
      );
      return ((r as { data?: HRActivityData }).data ?? r) as HRActivityData;
    },
    enabled: tab === "hr-activity",
  });

  const slaQuery = useQuery<SLAData>({
    queryKey: ["attendance-sla", days],
    queryFn: async () => {
      const r = await getJSON<unknown>(
        `/api/v1/staff/admin/audit/attendance/sla?days=${days}`,
      );
      return ((r as { data?: SLAData }).data ?? r) as SLAData;
    },
    enabled: tab === "sla",
  });

  const geofenceQuery = useQuery<GeofenceData>({
    queryKey: ["attendance-geofence"],
    queryFn: async () => {
      const r = await getJSON<unknown>(
        "/api/v1/staff/admin/audit/attendance/geofence",
      );
      return ((r as { data?: GeofenceData }).data ?? r) as GeofenceData;
    },
    enabled: tab === "geofence",
  });

  const dash = dashQuery.data;
  const totalOverdue = dash?.overdue_items?.length ?? 0;

  const TABS: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "hr-activity", label: "HR Activity" },
    { key: "sla", label: "SLA Compliance" },
    { key: "geofence", label: "Geofence Log" },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="text-primary" size={22} />
            <h1 className="text-2xl font-bold text-gray-900">
              Attendance Audit
            </h1>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Super-admin oversight of leave, regularization, disputes, overtime,
            and HR actions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Period:</label>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {/* Overdue alert */}
      {totalOverdue > 0 && (
        <div className="mb-5 flex items-center gap-3 bg-amber-600 text-white px-4 py-3 rounded-xl">
          <AlertTriangle size={18} className="shrink-0" />
          <span className="font-semibold">
            {totalOverdue} attendance request(s) past SLA — HR action required
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === t.key
                ? "bg-primary text-white"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {tab === "overview" && (
        <div className="space-y-6">
          {/* Module summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {dashQuery.isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))
            ) : (
              <>
                <ModuleCard
                  icon={<Calendar size={18} className="text-blue-500" />}
                  label="Leave Requests"
                  pending={Number(dash?.leave?.pending_count ?? 0)}
                  overdue={Number(dash?.leave?.overdue_count ?? 0)}
                  approved={Number(dash?.leave?.approved_count ?? 0)}
                  rejected={Number(dash?.leave?.rejected_count ?? 0)}
                  slaLabel="48h SLA"
                />
                <ModuleCard
                  icon={<Clock size={18} className="text-orange-500" />}
                  label="Regularization"
                  pending={Number(dash?.regularization?.pending_count ?? 0)}
                  overdue={Number(dash?.regularization?.overdue_count ?? 0)}
                  approved={Number(dash?.regularization?.approved_count ?? 0)}
                  rejected={Number(dash?.regularization?.rejected_count ?? 0)}
                  slaLabel="24h SLA"
                />
                <ModuleCard
                  icon={<AlertTriangle size={18} className="text-red-500" />}
                  label="Disputes"
                  pending={Number(dash?.disputes?.pending_count ?? 0)}
                  overdue={Number(dash?.disputes?.overdue_count ?? 0)}
                  approved={Number(dash?.disputes?.approved_count ?? 0)}
                  rejected={Number(dash?.disputes?.rejected_count ?? 0)}
                  slaLabel="24h SLA"
                />
                <ModuleCard
                  icon={<TrendingUp size={18} className="text-purple-500" />}
                  label="Overtime"
                  pending={Number(dash?.overtime?.pending_count ?? 0)}
                  overdue={Number(dash?.overtime?.overdue_count ?? 0)}
                  approved={Number(dash?.overtime?.approved_count ?? 0)}
                  rejected={Number(dash?.overtime?.rejected_count ?? 0)}
                  slaLabel="72h SLA"
                />
              </>
            )}
          </div>

          {/* Geofence quick stat */}
          {!dashQuery.isLoading && (
            <div className="bg-card border border-gray-200 rounded-xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
                <MapPin size={18} className="text-red-500" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-700">
                  Geofence Breaches (last 7 days)
                </p>
                <p className="text-xs text-gray-500">
                  {String(dash?.geofence?.this_week ?? 0)} breaches across{" "}
                  {String(dash?.geofence?.unique_staff ?? 0)} staff members
                </p>
              </div>
              <button
                onClick={() => setTab("geofence")}
                className="text-xs text-primary font-medium hover:underline"
              >
                View log →
              </button>
            </div>
          )}

          {/* Overdue items table */}
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
              <XCircle size={14} className="text-red-500" />
              Past SLA — Needs Immediate Action
              {totalOverdue > 0 && (
                <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">
                  {totalOverdue}
                </span>
              )}
            </h2>
            {dashQuery.isLoading ? (
              <Skeleton className="h-32 rounded-xl" />
            ) : (dash?.overdue_items?.length ?? 0) === 0 ? (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-green-700 text-sm flex items-center gap-2">
                <CheckCircle size={16} /> All attendance requests are within SLA
              </div>
            ) : (
              <div className="bg-card border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                        Type
                      </th>
                      <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                        Subject
                      </th>
                      <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                        Submitted
                      </th>
                      <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                        Time Overdue
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {dash?.overdue_items?.map((item, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${typeColor(item.type)}`}
                          >
                            {item.type}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-700 truncate max-w-64">
                          {item.subject?.replace(/_/g, " ")}
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">
                          {hoursAgo(item.created_at)}
                        </td>
                        <td className="px-4 py-3 text-red-600 font-semibold text-xs">
                          {formatH(item.hours_pending)} overdue
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── HR ACTIVITY TAB ── */}
      {tab === "hr-activity" && (
        <div className="space-y-6">
          {activityQuery.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : (
            <>
              {/* Per-person breakdown */}
              <section>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Users size={14} /> HR / Admin Action Breakdown (last {days}{" "}
                  days)
                </h2>
                {(activityQuery.data?.actors?.length ?? 0) === 0 ? (
                  <div className="bg-gray-50 rounded-xl p-6 text-center text-sm text-gray-500">
                    No HR activity recorded
                  </div>
                ) : (
                  <div className="bg-card border border-gray-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-sm min-w-max">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                            Staff Member
                          </th>
                          <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                            Role
                          </th>
                          <th className="text-right px-4 py-2.5 text-xs text-blue-500 font-medium">
                            Leave
                          </th>
                          <th className="text-right px-4 py-2.5 text-xs text-orange-500 font-medium">
                            Regulariz.
                          </th>
                          <th className="text-right px-4 py-2.5 text-xs text-red-500 font-medium">
                            Disputes
                          </th>
                          <th className="text-right px-4 py-2.5 text-xs text-purple-500 font-medium">
                            Overtime
                          </th>
                          <th className="text-right px-4 py-2.5 text-xs text-gray-500 font-medium">
                            Total
                          </th>
                          <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                            Last Active
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {activityQuery.data?.actors?.map((a) => {
                          const total =
                            a.leave +
                            a.regularization +
                            a.disputes +
                            a.overtime;
                          return (
                            <tr key={a.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3 font-medium">
                                {a.name}
                              </td>
                              <td className="px-4 py-3 text-gray-500 text-xs">
                                {a.role}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {a.leave || "—"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {a.regularization || "—"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {a.disputes || "—"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {a.overtime || "—"}
                              </td>
                              <td className="px-4 py-3 text-right font-bold">
                                {total}
                              </td>
                              <td className="px-4 py-3 text-gray-500 text-xs">
                                {a.last_action ? hoursAgo(a.last_action) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Bulk corrections */}
              {(activityQuery.data?.bulk_corrections?.length ?? 0) > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-amber-600 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <AlertTriangle size={14} /> Bulk Attendance Corrections
                    <span className="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full">
                      {activityQuery.data?.bulk_corrections?.length}
                    </span>
                  </h2>
                  <div className="bg-card border border-amber-200 rounded-xl divide-y text-sm">
                    {activityQuery.data?.bulk_corrections?.map((c, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-4 py-3"
                      >
                        <div className="flex-1">
                          <p className="font-medium">
                            {String(c.staff_name ?? "—")}
                          </p>
                          <p className="text-xs text-gray-500">
                            {String(c.date ?? "")} · {String(c.reason ?? "")}
                          </p>
                        </div>
                        <div className="text-right text-xs">
                          <p className="text-gray-600">
                            {String(c.reviewed_by_name ?? "Unreviewed")}
                          </p>
                          <p
                            className={
                              c.status === "approved"
                                ? "text-green-600 font-medium"
                                : "text-gray-400"
                            }
                          >
                            {String(c.status ?? "")}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {/* ── SLA TAB ── */}
      {tab === "sla" && (
        <div className="space-y-4">
          {slaQuery.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(
                ["leave", "regularization", "disputes", "overtime"] as const
              ).map((key) => {
                const row = slaQuery.data?.[key];
                if (!row) return null;
                const total = row.total || 0;
                const actioned = row.actioned || 0;
                const withinSLA = row.within_sla || 0;
                const compliancePct =
                  actioned > 0
                    ? Math.round((withinSLA / actioned) * 100)
                    : null;
                const overdueCount = row.overdue || 0;

                return (
                  <div
                    key={key}
                    className={`bg-card border rounded-xl p-5 ${overdueCount > 0 ? "border-red-300" : "border-gray-200"}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <p className="font-semibold text-gray-800">{row.label}</p>
                      <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                        SLA: {row.sla_hours}h
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center mb-3">
                      <div>
                        <p className="text-2xl font-bold text-gray-900">
                          {total}
                        </p>
                        <p className="text-xs text-gray-500">Total</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-green-600">
                          {actioned}
                        </p>
                        <p className="text-xs text-gray-500">Actioned</p>
                      </div>
                      <div>
                        <p
                          className={`text-2xl font-bold ${compliancePct !== null && compliancePct < 70 ? "text-red-600" : "text-green-600"}`}
                        >
                          {compliancePct !== null ? `${compliancePct}%` : "—"}
                        </p>
                        <p className="text-xs text-gray-500">Within SLA</p>
                      </div>
                    </div>
                    {overdueCount > 0 && (
                      <div className="bg-red-50 text-red-700 text-xs px-3 py-1.5 rounded-lg font-medium">
                        ⚠️ {overdueCount} currently overdue
                      </div>
                    )}
                    <p className="text-xs text-gray-400 mt-2">
                      Avg response time: {formatH(row.avg_hours)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── GEOFENCE TAB ── */}
      {tab === "geofence" && (
        <div className="space-y-6">
          {geofenceQuery.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : (
            <>
              {/* Stats row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Total Breaches"
                  value={String(geofenceQuery.data?.stats?.total ?? 0)}
                />
                <StatCard
                  label="This Week"
                  value={String(geofenceQuery.data?.stats?.this_week ?? 0)}
                  alert={(geofenceQuery.data?.stats?.this_week ?? 0) > 5}
                />
                <StatCard
                  label="Unique Staff"
                  value={String(geofenceQuery.data?.stats?.unique_staff ?? 0)}
                />
                <StatCard
                  label="Check-in Outside"
                  value={String(
                    geofenceQuery.data?.stats?.checkin_outside ?? 0,
                  )}
                  alert={(geofenceQuery.data?.stats?.checkin_outside ?? 0) > 0}
                />
              </div>

              {/* Frequent offenders */}
              {(geofenceQuery.data?.frequent_offenders?.length ?? 0) > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Users size={14} /> Repeat Offenders (last 30 days)
                  </h2>
                  <div className="bg-card border border-gray-200 rounded-xl divide-y">
                    {geofenceQuery.data?.frequent_offenders?.map((o, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-4 py-3"
                      >
                        <div className="w-8 h-8 bg-red-50 rounded-full flex items-center justify-center text-red-600 font-bold text-sm shrink-0">
                          {o.breach_count}
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-sm">{o.name}</p>
                          <p className="text-xs text-gray-500">
                            {o.department}
                          </p>
                        </div>
                        <p className="text-xs text-gray-400">
                          Last: {hoursAgo(o.last_breach)}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Breach log */}
              <section>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Activity size={14} /> Breach Log
                </h2>
                <div className="bg-card border border-gray-200 rounded-xl overflow-hidden">
                  {(geofenceQuery.data?.breaches?.length ?? 0) === 0 ? (
                    <div className="p-6 text-center text-sm text-green-600">
                      <CheckCircle className="mx-auto mb-2" size={24} />
                      No geofence breaches recorded
                    </div>
                  ) : (
                    <div className="divide-y max-h-96 overflow-y-auto">
                      {geofenceQuery.data?.breaches?.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center gap-3 px-4 py-3"
                        >
                          <MapPin
                            size={14}
                            className={
                              b.action === "checkin_outside"
                                ? "text-red-500"
                                : "text-orange-400"
                            }
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {b.staff_name}
                            </p>
                            <p className="text-xs text-gray-500">
                              {b.department} · {b.action.replace(/_/g, " ")}
                              {b.distance_meters
                                ? ` · ${b.distance_meters}m from campus`
                                : ""}
                            </p>
                          </div>
                          <p className="text-xs text-gray-400 shrink-0">
                            {hoursAgo(b.occurred_at)}
                          </p>
                          {!b.alerted && (
                            <span className="text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 px-1.5 py-0.5 rounded shrink-0">
                              unalerted
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function ModuleCard({
  icon,
  label,
  pending,
  overdue,
  approved,
  rejected,
  slaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  pending: number;
  overdue: number;
  approved: number;
  rejected: number;
  slaLabel: string;
}) {
  return (
    <div
      className={`bg-card border rounded-xl p-4 ${overdue > 0 ? "border-red-300" : "border-gray-200"}`}
    >
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs text-gray-500 font-medium">{label}</span>
      </div>
      <p
        className={`text-3xl font-bold mb-1 ${overdue > 0 ? "text-red-600" : "text-gray-900"}`}
      >
        {pending}
      </p>
      <p className="text-xs text-gray-500">pending</p>
      {overdue > 0 && (
        <p className="text-xs text-red-600 font-medium mt-1">
          {overdue} past {slaLabel}
        </p>
      )}
      <div className="flex gap-3 mt-2 text-xs text-gray-400">
        <span className="text-green-600">✓ {approved}</span>
        <span className="text-red-400">✗ {rejected}</span>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`bg-card border rounded-xl p-4 ${alert ? "border-red-300" : "border-gray-200"}`}
    >
      <p className="text-xs text-gray-500 font-medium mb-1">{label}</p>
      <p
        className={`text-3xl font-bold ${alert ? "text-red-600" : "text-gray-900"}`}
      >
        {value}
      </p>
    </div>
  );
}
