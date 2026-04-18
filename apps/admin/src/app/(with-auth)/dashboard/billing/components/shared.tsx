"use client";

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

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

export const INVOICE_STATUS_COLORS: Record<string, string> = {
  paid: "bg-green-100 text-green-700",
  pending: "bg-orange-100 text-orange-700",
  partial: "bg-blue-100 text-blue-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-600",
};

export const CLAIM_STATUS_COLORS: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-700",
  under_review: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  partially_approved: "bg-teal-100 text-teal-700",
  rejected: "bg-red-100 text-red-700",
  paid: "bg-emerald-100 text-emerald-700",
};

export function StatusBadge({
  status,
  colorMap,
}: {
  status: string;
  colorMap: Record<string, string>;
}) {
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${
        colorMap[status.toLowerCase()] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status}
    </span>
  );
}

export function fmt(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}
