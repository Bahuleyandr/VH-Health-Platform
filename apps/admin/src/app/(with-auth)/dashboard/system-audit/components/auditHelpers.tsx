"use client";

// Shared colour maps, formatters, and the StatCard widget used by every
// system-audit tab. Extracted from page.tsx.

export const METHOD_COLORS: Record<string, string> = {
  GET: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  POST: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  PUT: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  PATCH:
    "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
  DELETE: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

export const MODULE_COLORS: Record<string, string> = {
  attendance: "bg-blue-100 text-blue-800",
  leave: "bg-teal-100 text-teal-800",
  incidents: "bg-orange-100 text-orange-800",
  grievances: "bg-purple-100 text-purple-800",
  auth: "bg-gray-100 text-gray-700",
  shifts: "bg-indigo-100 text-indigo-800",
  overtime: "bg-yellow-100 text-yellow-800",
  replacement: "bg-pink-100 text-pink-800",
  users: "bg-sky-100 text-sky-800",
  staff: "bg-sky-100 text-sky-800",
  doctors: "bg-emerald-100 text-emerald-800",
  patients: "bg-lime-100 text-lime-800",
  appointments: "bg-cyan-100 text-cyan-800",
  pharmacy: "bg-rose-100 text-rose-800",
  investigations: "bg-amber-100 text-amber-800",
  admin: "bg-slate-100 text-slate-800",
};

export function methodBadge(method: string) {
  const cls = METHOD_COLORS[method] || "bg-gray-100 text-gray-700";
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-bold ${cls}`}
    >
      {method}
    </span>
  );
}

export function statusBadge(code: number) {
  const cls =
    code < 300
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
      : code < 500
        ? "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
        : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${cls}`}
    >
      {code}
    </span>
  );
}

export function moduleBadge(mod: string | null) {
  if (!mod) return null;
  const cls = MODULE_COLORS[mod] || "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}>
      {mod}
    </span>
  );
}

export function truncate(str: string | null, n: number) {
  if (!str) return "-";
  return str.length > n ? str.substring(0, n) + "…" : str;
}

export function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function StatCard({
  label,
  value,
  sub,
  color = "blue",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  const colorMap: Record<string, string> = {
    blue: "border-blue-500",
    red: "border-red-500",
    green: "border-green-500",
    yellow: "border-yellow-500",
    purple: "border-purple-500",
  };
  return (
    <div
      className={`bg-card dark:bg-gray-800 rounded-lg p-4 border-l-4 shadow-sm ${colorMap[color] || colorMap.blue}`}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
        {value}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
