"use client";

// Shared helpers + display primitives for the investigations admin page.

export function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d;
  }
}

export function priorityColor(p: string) {
  const u = p?.toUpperCase();
  if (u === "URGENT" || u === "STAT") return "bg-red-100 text-red-800";
  if (u === "HIGH") return "bg-orange-100 text-orange-800";
  return "bg-gray-100 text-gray-700";
}

export function statusColor(s: string) {
  const u = s?.toUpperCase();
  if (u === "COMPLETED" || u === "RESULT_READY") return "bg-green-100 text-green-800";
  if (u === "PENDING") return "bg-yellow-100 text-yellow-800";
  if (u === "IN_PROGRESS") return "bg-blue-100 text-blue-800";
  if (u === "CANCELLED") return "bg-gray-200 text-gray-500";
  return "bg-gray-100 text-gray-700";
}

export function Chip({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

export function SummaryCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${color ?? ""}`}>{value}</p>
    </div>
  );
}

export function SlaCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold ${color ?? ""}`}>{value}</p>
    </div>
  );
}
