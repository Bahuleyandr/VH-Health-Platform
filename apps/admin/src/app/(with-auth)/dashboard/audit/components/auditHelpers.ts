// src/app/(with-auth)/dashboard/audit/components/auditHelpers.ts
// Pure-function helpers shared across the overview / activity / SLA tabs
// + trail panel.

export function severityColor(s: string) {
  const m: Record<string, string> = {
    sentinel: "text-red-900 bg-red-100 border-red-400",
    severe: "text-red-700 bg-red-50 border-red-300",
    moderate: "text-orange-700 bg-orange-50 border-orange-300",
    low: "text-green-700 bg-green-50 border-green-200",
  };
  return m[s] ?? "text-gray-600 bg-gray-50 border-gray-200";
}

export function hoursAgo(iso: string) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatHours(h: number | null) {
  if (!h) return "—";
  if (h < 24) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
