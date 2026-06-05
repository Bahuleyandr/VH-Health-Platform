"use client";

import React from "react";
import {
  AlertTriangle,
  Clock,
  Users,
  TrendingUp,
  Activity,
  CheckCircle,
  XCircle,
  Eye,
} from "lucide-react";
import { Skeleton } from "@/components/ui";
import { StatCard } from "./StatCard";
import { severityColor, hoursAgo, formatHours } from "./auditHelpers";
import type { AuditDashboardData, TrailTarget } from "./types";

interface Props {
  data: AuditDashboardData | undefined;
  isLoading: boolean;
  onOpenTrail: (target: TrailTarget) => void;
}

export function AuditOverviewTab({
  data: dash,
  isLoading,
  onOpenTrail,
}: Props) {
  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))
        ) : (
          <>
            <StatCard
              icon={<AlertTriangle size={20} className="text-orange-500" />}
              label="Open Incidents"
              value={String(dash?.incidents?.open_count ?? 0)}
              sub={`${dash?.incidents?.overdue_new ?? 0} overdue`}
              alert={(dash?.incidents?.overdue_new as number) > 0}
            />
            <StatCard
              icon={<Users size={20} className="text-purple-500" />}
              label="Open Grievances"
              value={String(dash?.grievances?.open_count ?? 0)}
              sub={`${dash?.grievances?.overdue_new ?? 0} overdue`}
              alert={(dash?.grievances?.overdue_new as number) > 0}
            />
            <StatCard
              icon={<Clock size={20} className="text-blue-500" />}
              label="Unassigned"
              value={String(dash?.unassigned?.length ?? 0)}
              sub="need assignment"
              alert={(dash?.unassigned?.length ?? 0) > 0}
            />
            <StatCard
              icon={<TrendingUp size={20} className="text-green-500" />}
              label="Avg Resolution"
              value={`${formatHours(Number(dash?.incidents?.avg_resolution_hours))}`}
              sub="incidents"
            />
          </>
        )}
      </div>

      {/* SLA Breaches — header copy adapts to data state so the page doesn't
          flash "Action Required" before we know whether there even are any. */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
          <XCircle
            size={14}
            className={isLoading ? "text-gray-400" : "text-red-500"}
          />
          {isLoading
            ? "SLA Status"
            : (dash?.sla_breaches?.length ?? 0) > 0
              ? "SLA Breaches — Action Required"
              : "SLA Status"}
          {!isLoading && (dash?.sla_breaches?.length ?? 0) > 0 && (
            <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">
              {dash?.sla_breaches?.length}
            </span>
          )}
        </h2>
        {isLoading ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : dash?.sla_breaches?.length === 0 ? (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-green-700 text-sm flex items-center gap-2">
            <CheckCircle size={16} /> All reports are within SLA thresholds
          </div>
        ) : (
          <div className="bg-card border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                    Report
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                    Severity
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                    Time Open
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                    Assigned To
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">
                    Admin Actions
                  </th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {dash?.sla_breaches?.map((b) => (
                  <tr key={`${b.type}-${b.id}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">
                        {b.report_number}
                      </p>
                      <p className="text-xs text-gray-500 truncate max-w-48">
                        {b.title}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border font-medium ${severityColor(b.severity)}`}
                      >
                        {b.severity?.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-red-600 font-semibold">
                      {formatHours(b.hours_open)}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {b.assigned_to_name ?? (
                        <span className="text-red-500 text-xs">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {b.admin_action_count === 0 ? (
                        <span className="text-xs text-red-600 font-medium">
                          No action taken
                        </span>
                      ) : (
                        <span className="text-xs text-gray-500">
                          {b.admin_action_count} action(s)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() =>
                          onOpenTrail({
                            type: b.type as "incident" | "grievance",
                            id: String(b.id),
                            number: b.report_number,
                          })
                        }
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Eye size={12} /> Trail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Unassigned + Recent activity side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Unassigned */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
            <AlertTriangle size={14} className="text-yellow-500" />
            Unassigned Reports
          </h2>
          <div className="bg-card border border-gray-200 rounded-xl divide-y max-h-80 overflow-y-auto">
            {dash?.unassigned?.length === 0 ? (
              <div className="p-4 text-sm text-gray-500 text-center">
                All reports are assigned ✓
              </div>
            ) : (
              dash?.unassigned?.map((u) => (
                <div
                  key={`${u.type}-${u.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50"
                >
                  <div
                    className={`w-2 h-2 rounded-full ${u.type === "incident" ? "bg-orange-400" : "bg-purple-400"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-500">
                      {u.report_number}
                    </p>
                    <p className="text-sm truncate">{u.subject}</p>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">
                    {hoursAgo(u.created_at)}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Recent activity */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
            <Activity size={14} className="text-blue-500" />
            Recent Admin Activity
          </h2>
          <div className="bg-card border border-gray-200 rounded-xl divide-y max-h-80 overflow-y-auto">
            {dash?.recent_activity?.length === 0 ? (
              <div className="p-4 text-sm text-gray-500 text-center">
                No recent activity
              </div>
            ) : (
              dash?.recent_activity?.map((a) => (
                <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                  <div
                    className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${a.report_type === "incident" ? "bg-orange-400" : "bg-purple-400"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-bold text-gray-500">
                        {a.report_number}
                      </span>
                      <span className="text-xs text-gray-400">·</span>
                      <span className="text-xs font-medium">
                        {a.author_name}
                      </span>
                      {a.is_internal && (
                        <span className="text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 px-1.5 py-0.5 rounded">
                          internal
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">
                      {a.message}
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">
                    {hoursAgo(a.created_at)}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
