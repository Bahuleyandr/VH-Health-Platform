// src/app/(with-auth)/dashboard/audit/components/TrailPanel.tsx
// Renders the audit-trail timeline inside the modal — SLA summary,
// report header, and per-action entries.

"use client";

import React from "react";

interface Props {
  data: Record<string, unknown> | null;
}

export function TrailPanel({ data }: Props) {
  if (!data) return <p className="text-gray-500 text-sm">No data</p>;

  const report = data.report as Record<string, unknown> | undefined;
  const trail =
    (data.audit_trail as Array<Record<string, unknown>> | undefined) ?? [];
  const sla = data.sla as Record<string, unknown> | undefined;

  return (
    <div className="space-y-4">
      {/* SLA summary */}
      {sla && (
        <div
          className={`rounded-lg p-3 border text-sm ${
            sla.resolve_breached
              ? "bg-red-50 border-red-200"
              : "bg-green-50 border-green-200"
          }`}
        >
          <p className="font-medium mb-1">
            {sla.resolve_breached ? "⚠️ SLA Breached" : "✓ Within SLA"}
          </p>
          <p className="text-xs text-gray-600">
            Open {String(sla.hours_open)}h · Resolve threshold:{" "}
            {String(sla.resolve_threshold_hours)}h
            {sla.resolved_within_sla !== null &&
              ` · Resolved within SLA: ${sla.resolved_within_sla ? "Yes" : "No"}`}
          </p>
        </div>
      )}

      {/* Report summary */}
      {report && (
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-semibold">
            {String(report.report_number ?? report.grievance_number ?? "")}
          </p>
          <p className="text-gray-700 mt-0.5">
            {String(report.title ?? report.subject ?? "")}
          </p>
          <div className="flex gap-4 mt-2 text-xs text-gray-500">
            <span>
              Status: <b className="text-gray-800">{String(report.status ?? "")}</b>
            </span>
            {report.assigned_to_name ? (
              <span>
                Assigned:{" "}
                <b className="text-gray-800">
                  {String(report.assigned_to_name)}
                </b>
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase mb-3">
          Timeline ({trail.length} entries)
        </p>
        <div className="relative pl-5 border-l-2 border-gray-200 space-y-4">
          {trail.map((entry, i) => (
            <div key={i} className="relative">
              <div
                className={`absolute -left-[21px] top-1 w-3 h-3 rounded-full border-2 border-white ${
                  entry.author_role === "system"
                    ? "bg-gray-300"
                    : entry.author_role === "reporter"
                    ? "bg-blue-400"
                    : entry.is_internal
                    ? "bg-yellow-400"
                    : "bg-green-400"
                } `}
              />
              <div className="bg-white border border-gray-200 rounded-lg p-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-gray-800">
                    {entry.author_name
                      ? String(entry.author_name)
                      : String(entry.author_role ?? "")}
                  </span>
                  {entry.is_internal ? (
                    <span className="text-xs bg-yellow-50 border border-yellow-200 text-yellow-700 px-1.5 py-0.5 rounded">
                      internal note
                    </span>
                  ) : null}
                  <span className="text-xs text-gray-400 ml-auto">
                    {new Date(String(entry.created_at)).toLocaleString("en-IN", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                </div>
                <p className="text-gray-600">{String(entry.message ?? "")}</p>
              </div>
            </div>
          ))}
          {trail.length === 0 && (
            <p className="text-sm text-gray-500">No actions recorded yet</p>
          )}
        </div>
      </div>
    </div>
  );
}
