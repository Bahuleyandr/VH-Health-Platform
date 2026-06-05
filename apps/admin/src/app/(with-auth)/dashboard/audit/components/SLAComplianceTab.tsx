"use client";

import React from "react";
import { Skeleton } from "@/components/ui";
import { severityColor, formatHours } from "./auditHelpers";
import type { SLAData } from "./types";

interface Props {
  data: SLAData | undefined;
  isLoading: boolean;
}

export function SLAComplianceTab({ data, isLoading }: Props) {
  return (
    <div className="space-y-6">
      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <>
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Incident SLA by Severity
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data?.incident_sla?.map((row) => {
                const compliance =
                  row.resolved > 0
                    ? Math.round(
                        (Number(row.resolved_within_sla) / row.resolved) * 100,
                      )
                    : null;
                return (
                  <div
                    key={row.severity}
                    className={`bg-card border rounded-xl p-4 ${row.currently_breached > 0 ? "border-red-300" : "border-gray-200"}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border font-bold ${severityColor(row.severity)}`}
                      >
                        {row.severity?.toUpperCase()}
                      </span>
                      {row.currently_breached > 0 && (
                        <span className="text-xs text-red-600 font-semibold">
                          {row.currently_breached} breached now
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-xl font-bold">{row.total}</p>
                        <p className="text-xs text-gray-500">Total</p>
                      </div>
                      <div>
                        <p className="text-xl font-bold text-green-600">
                          {row.resolved}
                        </p>
                        <p className="text-xs text-gray-500">Resolved</p>
                      </div>
                      <div>
                        <p
                          className={`text-xl font-bold ${compliance !== null && compliance < 70 ? "text-red-600" : "text-green-600"}`}
                        >
                          {compliance !== null ? `${compliance}%` : "—"}
                        </p>
                        <p className="text-xs text-gray-500">Within SLA</p>
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 mt-2 text-center">
                      Avg resolution: {formatHours(row.avg_resolution_hours)}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Grievance SLA by Priority
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {data?.grievance_sla?.map((row) => (
                <div
                  key={row.priority}
                  className={`bg-card border rounded-xl p-4 ${row.currently_breached > 0 ? "border-red-300" : "border-gray-200"}`}
                >
                  <p className="font-semibold text-sm capitalize mb-2">
                    {row.priority}
                  </p>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">
                      Total: <b>{row.total}</b>
                    </span>
                    <span className="text-green-600">
                      Resolved: <b>{row.resolved}</b>
                    </span>
                  </div>
                  {row.currently_breached > 0 && (
                    <p className="text-xs text-red-600 mt-1 font-medium">
                      {row.currently_breached} currently past SLA
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    Avg: {formatHours(row.avg_resolution_hours)}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
