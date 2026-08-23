"use client";

export function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const GREEN = new Set(["active", "completed", "approved", "running", "started"]);
const AMBER = new Set(["pending", "blocked", "retiring", "queued"]);
const RED = new Set(["failed", "rejected", "cancelled", "expired", "inactive"]);

export function StatusPill({ value }: { value: string }) {
  const color = GREEN.has(value)
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : AMBER.has(value)
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : RED.has(value)
        ? "border-red-200 bg-red-50 text-red-800"
        : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

function describeValue(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.every((item) => typeof item === "string" || typeof item === "number")) {
      return v.join(", ");
    }
    return `${v.length} entries`;
  }
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

/**
 * Compact human summary of an escalation rule's action_payload —
 * surfaces the tier/role targets an on-call admin cares about.
 */
export function summarizeActionPayload(
  payload: Record<string, unknown> | null | undefined,
): string {
  if (!payload || Object.keys(payload).length === 0) return "—";
  const parts: string[] = [];
  for (const key of [
    "tiers",
    "roles",
    "notify_roles",
    "target_role",
    "escalate_to_role",
    "assigned_to_role",
    "priority",
    "channel",
  ]) {
    const v = payload[key];
    if (v === undefined || v === null) continue;
    parts.push(`${key.replace(/_/g, " ")}: ${describeValue(v)}`);
  }
  if (parts.length) return parts.join(" · ");
  const json = JSON.stringify(payload);
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}
