"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui";
import { formatHours, hoursAgo } from "./auditHelpers";
import type { AdminActivityData } from "./types";

interface Props {
  data: AdminActivityData | undefined;
  isLoading: boolean;
  days: number;
}

export function HRActivityTab({ data, isLoading, days }: Props) {
  return (
    <div className="space-y-6">
      {isLoading ? <Skeleton className="h-64 rounded-xl" /> : (
        <>
          {/* Resolution stats */}
          <div className="grid grid-cols-2 gap-4">
            {data?.resolution_stats?.map(rs => (
              <div key={rs.type} className="bg-white border border-gray-200 rounded-xl p-5">
                <p className="text-xs text-gray-500 uppercase font-medium mb-1 capitalize">{rs.type} Resolution</p>
                <p className="text-3xl font-bold text-gray-900">{rs.resolution_rate_pct ?? 0}%</p>
                <p className="text-sm text-gray-500">{rs.resolved}/{rs.total} resolved · avg {formatHours(rs.avg_hours_to_resolve)}</p>
              </div>
            ))}
          </div>

          {/* Per-admin table */}
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">HR / Admin Actions (last {days} days)</h2>
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {(data?.admin_activity?.length ?? 0) === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No admin activity recorded</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Staff Member</th>
                      <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Role</th>
                      <th className="text-right px-4 py-2.5 text-xs text-gray-500 font-medium">Incidents</th>
                      <th className="text-right px-4 py-2.5 text-xs text-gray-500 font-medium">Grievances</th>
                      <th className="text-right px-4 py-2.5 text-xs text-gray-500 font-medium">Total Actions</th>
                      <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Last Active</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data?.admin_activity?.map(a => (
                      <tr key={a.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium">{a.name}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{a.role}</td>
                        <td className="px-4 py-3 text-right">{a.incident_actions}</td>
                        <td className="px-4 py-3 text-right">{a.grievance_actions}</td>
                        <td className="px-4 py-3 text-right font-bold">{a.total_actions}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{a.last_action ? hoursAgo(a.last_action) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* Neglected reports */}
          {(data?.neglected_reports?.length ?? 0) > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-red-600 uppercase tracking-wide mb-3 flex items-center gap-2">
                <AlertTriangle size={14} /> Reports with Zero Admin Action
              </h2>
              <div className="bg-white border border-red-200 rounded-xl divide-y">
                {data?.neglected_reports?.map((r, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${r.type === "incident" ? "bg-orange-100 text-orange-700" : "bg-purple-100 text-purple-700"}`}>
                      {r.report_number}
                    </span>
                    <p className="flex-1 text-sm truncate">{r.subject}</p>
                    <span className="text-xs text-red-600 font-medium">{formatHours(r.hours_open)} open</span>
                    <span className="text-xs text-gray-500">{r.assigned_to_name ?? "Unassigned"}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
