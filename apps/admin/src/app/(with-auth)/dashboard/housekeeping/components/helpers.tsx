// Shared helpers + badge styling for the housekeeping feature.
//
// Extracted from the original 1268-LOC `page.tsx` on 2026-04-14. Any cross-tab
// utility (date formatting, SLA chip, badge styles, JSON unwrap) lives here so
// each tab component is testable in isolation.

import React from "react";

/** Unwrap `{ data: T }` envelopes. */
export function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

/** Localised short date-time formatter, accepts null/undefined safely. */
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/** SLA countdown chip with traffic-light colour coding. */
export function fmtSLA(sla_due_at: string | null | undefined, status: string) {
  if (!sla_due_at) return <span className="text-gray-400 text-xs">—</span>;
  if (["completed", "verified", "closed", "cancelled"].includes(status)) {
    return <span className="text-gray-400 text-xs">Done</span>;
  }
  const diff = new Date(sla_due_at).getTime() - Date.now();
  const mins = Math.round(diff / 60000);
  if (mins < 0) {
    const overMins = Math.abs(mins);
    const label = overMins >= 60 ? `${Math.round(overMins / 60)}h` : `${overMins}m`;
    return <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">OVERDUE {label}</span>;
  }
  const label = mins >= 60 ? `${Math.round(mins / 60)}h left` : `${mins}m left`;
  const color = mins < 30 ? "text-orange-600 bg-orange-50 border-orange-200" : "text-green-600 bg-green-50 border-green-200";
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${color}`}>{label}</span>;
}

export const URGENCY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 border-red-300 animate-pulse",
  high: "bg-orange-100 text-orange-700 border-orange-300",
  normal: "bg-gray-100 text-gray-600 border-gray-300",
  low: "bg-green-100 text-green-700 border-green-300",
};

export const STATUS_STYLES: Record<string, string> = {
  submitted: "bg-gray-100 text-gray-600 border-gray-300",
  verified: "bg-green-100 text-green-700 border-green-300",
  flagged: "bg-red-100 text-red-700 border-red-300",
  open: "bg-blue-100 text-blue-700 border-blue-300",
  assigned: "bg-yellow-100 text-yellow-700 border-yellow-300",
  in_progress: "bg-purple-100 text-purple-700 border-purple-300",
  completed: "bg-teal-100 text-teal-700 border-teal-300",
  closed: "bg-gray-100 text-gray-600 border-gray-300",
  cancelled: "bg-red-50 text-red-400 border-red-200",
};

export function Badge({ value, styleMap }: { value: string; styleMap: Record<string, string> }) {
  const cls = styleMap[value] ?? "bg-gray-100 text-gray-600 border-gray-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border ${cls}`}>
      {value.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

export function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    teal: "bg-teal-50 border-teal-200 text-teal-700",
    blue: "bg-blue-50 border-blue-200 text-blue-700",
    red: "bg-red-50 border-red-200 text-red-700",
    orange: "bg-orange-50 border-orange-200 text-orange-700",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] ?? colors.teal}`}>
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-xs mt-1 opacity-75">{label}</div>
    </div>
  );
}

export function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-sm text-gray-800 mt-0.5">{value}</div>
    </div>
  );
}
