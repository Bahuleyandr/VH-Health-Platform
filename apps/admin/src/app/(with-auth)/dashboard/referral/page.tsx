"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { fetchAdminAPI } from "@/lib/api";

type ReferralAuditRow = {
  id: number;
  referral_number: string;
  patient_uid: string;
  patient_name?: string | null;
  referred_to_department: string;
  referred_to_doctor_name?: string | null;
  referring_doctor_name?: string | null;
  current_owner_uid?: string | null;
  current_owner_name?: string | null;
  urgency: string;
  status: string;
  closure_status?: string | null;
  closure_reason?: string | null;
  requested_at: string;
  first_seen_at?: string | null;
  minutes_to_first_seen?: number | null;
  accepted_at?: string | null;
  completed_at?: string | null;
  appointment_id?: number | null;
};

function rowsFromEnvelope(value: unknown): ReferralAuditRow[] {
  if (Array.isArray(value)) return value as ReferralAuditRow[];
  if (!value || typeof value !== "object") return [];
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) ? (data as ReferralAuditRow[]) : [];
}

function dateTime(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function label(value?: string | null) {
  return (value || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function badgeClass(value?: string | null) {
  const normalized = (value || "").toLowerCase();
  if (["closed", "completed", "accepted"].includes(normalized)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (["declined", "expired", "cancelled"].includes(normalized)) {
    return "border-red-200 bg-red-50 text-red-800";
  }
  if (["pending", "open", "in_progress"].includes(normalized)) {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  return "border-border bg-muted text-muted-foreground";
}

function Badge({ value }: { value?: string | null }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClass(value)}`}>
      {label(value)}
    </span>
  );
}

export default function ReferralPage() {
  const audit = useQuery({
    queryKey: ["referral-closed-loop-audit"],
    queryFn: async () => rowsFromEnvelope(
      await fetchAdminAPI<unknown>("/referrals/audit?limit=200"),
    ),
  });
  const rows = audit.data ?? [];
  const openCount = rows.filter((row) => row.closure_status !== "closed").length;
  const awaitingReceiver = rows.filter((row) => row.status === "pending").length;
  const awaitingOriginator = rows.filter(
    (row) => row.status === "completed" && row.closure_status !== "closed",
  ).length;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Referral closed-loop oversight</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Read-only operational evidence from request through named receiver acceptance,
            signed specialist response, and originator closure.
          </p>
        </div>
        <button
          type="button"
          onClick={() => audit.refetch()}
          disabled={audit.isFetching}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${audit.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="Open loops" value={openCount} />
        <Metric label="Awaiting receiver" value={awaitingReceiver} />
        <Metric label="Awaiting originator" value={awaitingOriginator} />
      </div>

      {audit.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {audit.error instanceof Error ? audit.error.message : "Could not load referral evidence."}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Referral</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">Current owner</th>
                <th className="px-4 py-3">Work</th>
                <th className="px-4 py-3">Closure</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">First seen</th>
                <th className="px-4 py-3">Appointment</th>
              </tr>
            </thead>
            <tbody>
              {audit.isLoading ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">Loading referral evidence…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">No referral evidence found.</td></tr>
              ) : rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.referral_number}</div>
                    <div className="text-xs text-muted-foreground">#{row.id} · {label(row.urgency)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{row.patient_name || "Patient"}</div>
                    <div className="max-w-52 truncate font-mono text-xs text-muted-foreground">{row.patient_uid}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{row.referred_to_department}</div>
                    <div className="text-xs text-muted-foreground">{row.referred_to_doctor_name || "Named receiver pending"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{row.current_owner_name || "Unresolved"}</div>
                    <div className="text-xs text-muted-foreground">From {row.referring_doctor_name || "originator"}</div>
                  </td>
                  <td className="px-4 py-3"><Badge value={row.status} /></td>
                  <td className="px-4 py-3">
                    <Badge value={row.closure_status || "open"} />
                    {row.closure_reason && <div className="mt-1 text-xs text-muted-foreground">{label(row.closure_reason)}</div>}
                  </td>
                  <td className="px-4 py-3">{dateTime(row.requested_at)}</td>
                  <td className="px-4 py-3">
                    <div>{dateTime(row.first_seen_at)}</div>
                    {row.minutes_to_first_seen != null && (
                      <div className="text-xs text-muted-foreground">{row.minutes_to_first_seen} min</div>
                    )}
                  </td>
                  <td className="px-4 py-3">{row.appointment_id ? `#${row.appointment_id}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Metric({ label: metricLabel, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm text-muted-foreground">{metricLabel}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}
