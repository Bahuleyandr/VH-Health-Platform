"use client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Advance {
  id: number;
  staff_name: string;
  department: string | null;
  amount: string;
  monthly_deduction: string;
  total_deducted: string;
  balance_remaining: string;
  status: string;
  deduction_start_month: number;
  deduction_start_year: number;
  reason: string;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function fmtMonth(m: number) {
  return MONTHS[(m - 1 + 12) % 12] ?? "—";
}

export function fmtCurrency(v: string | number | null | undefined): string {
  const n = parseFloat(String(v || 0));
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function statusBadge(status: string) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    processing: "bg-yellow-100 text-yellow-800",
    completed: "bg-green-100 text-green-800",
    completed_with_errors: "bg-red-100 text-red-800",
    locked: "bg-blue-100 text-blue-800",
    issued: "bg-green-100 text-green-800",
    pending_hr: "bg-orange-100 text-orange-800",
    pending_admin: "bg-purple-100 text-purple-800",
    approved: "bg-green-100 text-green-800",
    applied: "bg-teal-100 text-teal-800",
    rejected: "bg-red-100 text-red-800",
    cancelled: "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${map[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
