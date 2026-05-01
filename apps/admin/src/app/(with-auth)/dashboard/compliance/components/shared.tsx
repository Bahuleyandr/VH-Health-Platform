"use client";

// Shared UI helpers + style maps for the compliance dashboard god-split.

export function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

export function fmtDate(d?: string | null) {
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

export const SEVERITY_STYLES: Record<string, string> = {
  low: "bg-green-100 text-green-800",
  medium: "bg-yellow-100 text-yellow-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

export const STATUS_STYLES: Record<string, string> = {
  reported: "bg-blue-100 text-blue-800",
  investigating: "bg-yellow-100 text-yellow-800",
  contained: "bg-orange-100 text-orange-800",
  resolved: "bg-green-100 text-green-800",
  closed: "bg-gray-100 text-gray-600",
};

export function StatCard({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string | number;
  hint?: string;
  emphasis?: "neutral" | "ok" | "warn" | "danger";
}) {
  const tone = emphasis ?? "neutral";
  const cls =
    tone === "danger"
      ? "border-red-200 bg-red-50"
      : tone === "warn"
      ? "border-amber-200 bg-amber-50"
      : tone === "ok"
      ? "border-green-200 bg-green-50"
      : "border-border bg-card";
  const valCls =
    tone === "danger"
      ? "text-red-700"
      : tone === "warn"
      ? "text-amber-700"
      : tone === "ok"
      ? "text-green-700"
      : "";
  const labelCls =
    tone === "danger"
      ? "text-red-600"
      : tone === "warn"
      ? "text-amber-600"
      : tone === "ok"
      ? "text-green-600"
      : "text-muted-foreground";
  return (
    <div className={`border rounded-lg p-4 ${cls}`}>
      <p className={`text-sm ${labelCls}`}>{label}</p>
      <p className={`text-2xl font-bold ${valCls}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
