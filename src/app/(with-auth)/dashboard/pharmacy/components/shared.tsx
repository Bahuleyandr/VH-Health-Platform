// Shared display primitives + status colour map for pharmacy admin.

export function StatCard({
  label,
  value,
  color = "text-foreground",
  bg = "bg-card",
}: {
  label: string;
  value: string | number;
  color?: string;
  bg?: string;
}) {
  return (
    <div className={`${bg} border border-border rounded-lg p-4`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

export const STATUS_COLORS: Record<string, string> = {
  // Canonical 7-state lifecycle (post-2026-04-14 backend rename).
  PENDING: "bg-orange-100 text-orange-700",
  CONFIRMED: "bg-blue-100 text-blue-700",
  PREPARING: "bg-amber-100 text-amber-700",
  READY: "bg-purple-100 text-purple-700",
  DISPATCHED: "bg-teal-100 text-teal-700",
  DELIVERED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
  // Legacy alias retained for backward-compat with stale rows.
  PLACED: "bg-orange-100 text-orange-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

export function ActionButton({
  label,
  color,
  onClick,
  loading,
}: {
  label: string;
  color: string;
  onClick: () => void;
  loading: boolean;
}) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-100 text-blue-700 hover:bg-blue-200",
    amber: "bg-amber-100 text-amber-700 hover:bg-amber-200",
    teal: "bg-teal-100 text-teal-700 hover:bg-teal-200",
    green: "bg-green-100 text-green-700 hover:bg-green-200",
    red: "bg-red-100 text-red-700 hover:bg-red-200",
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`px-2 py-1 rounded text-xs font-medium ${colorMap[color] || "bg-gray-100"} ${
        loading ? "opacity-50 cursor-wait" : ""
      }`}
    >
      {loading ? "..." : label}
    </button>
  );
}
