"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  listPatientAccessAudit,
  type PatientAccessAuditEvent,
} from "@/lib/api/clinicalGovernance";
import { ErrorBanner, fmt, Pill, SectionCard, shortUid } from "./shared";

export function AccessAuditTab() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState({
    patient_uid: "",
    actor_uid: "",
    decision: "",
    source: "",
    action: "",
    record_type: "",
    resource_type: "",
    route: "",
    date_from: "",
    date_to: "",
  });
  const auditQuery = useQuery({
    queryKey: ["clinical-governance", "patient-access-audit", filter],
    queryFn: () =>
      listPatientAccessAudit({
        patient_uid: filter.patient_uid.trim() || undefined,
        actor_uid: filter.actor_uid.trim() || undefined,
        decision: filter.decision || undefined,
        source: filter.source || undefined,
        action: filter.action.trim() || undefined,
        record_type: filter.record_type.trim() || undefined,
        resource_type: filter.resource_type.trim() || undefined,
        route: filter.route.trim() || undefined,
        date_from: filter.date_from || undefined,
        date_to: filter.date_to || undefined,
        limit: 150,
      }),
  });
  const rows = auditQuery.data?.access_events ?? [];
  const allowed = rows.filter((row) => String(row.access_decision ?? "").toLowerCase() === "allow").length;
  const denied = rows.filter((row) => String(row.access_decision ?? "").toLowerCase() === "deny").length;

  return (
    <SectionCard
      title="Patient access audit"
      icon={Activity}
      action={
        <button
          type="button"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["clinical-governance", "patient-access-audit"] })}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 lg:grid-cols-4">
          <input
            value={filter.patient_uid}
            onChange={(event) => setFilter((current) => ({ ...current, patient_uid: event.target.value }))}
            placeholder="patient_uid"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
          <input
            value={filter.actor_uid}
            onChange={(event) => setFilter((current) => ({ ...current, actor_uid: event.target.value }))}
            placeholder="actor_uid"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
          <select
            value={filter.decision}
            onChange={(event) => setFilter((current) => ({ ...current, decision: event.target.value }))}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Any decision</option>
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
            <option value="break_glass">Break-glass</option>
          </select>
          <select
            value={filter.source}
            onChange={(event) => setFilter((current) => ({ ...current, source: event.target.value }))}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Any source</option>
            <option value="role">Role</option>
            <option value="care_team">Care team</option>
            <option value="appointment">Appointment</option>
            <option value="admission">Admission</option>
            <option value="guardian">Guardian</option>
            <option value="break_glass">Break-glass</option>
            <option value="unknown">Unknown</option>
          </select>
          <input
            value={filter.action}
            onChange={(event) => setFilter((current) => ({ ...current, action: event.target.value }))}
            placeholder="action"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            value={filter.record_type}
            onChange={(event) => setFilter((current) => ({ ...current, record_type: event.target.value }))}
            placeholder="record type"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            value={filter.resource_type}
            onChange={(event) => setFilter((current) => ({ ...current, resource_type: event.target.value }))}
            placeholder="resource type"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            value={filter.route}
            onChange={(event) => setFilter((current) => ({ ...current, route: event.target.value }))}
            placeholder="route contains"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={filter.date_from}
            onChange={(event) => setFilter((current) => ({ ...current, date_from: event.target.value }))}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={filter.date_to}
            onChange={(event) => setFilter((current) => ({ ...current, date_to: event.target.value }))}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
            {allowed} allowed
          </div>
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
            {denied} denied
          </div>
        </div>
        <ErrorBanner error={auditQuery.error} />
        {auditQuery.isLoading ? (
          <LoadingSpinner label="Loading audit events" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Activity className="h-8 w-8 text-muted-foreground" />}
            title="No audit events"
            description="Patient-access allow, deny, and break-glass events will appear here."
            compact
          />
        ) : (
          <AuditTable rows={rows} />
        )}
      </div>
    </SectionCard>
  );
}

function AuditTable({ rows }: { rows: PatientAccessAuditEvent[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">time</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">decision</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">patient</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">actor</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">record</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">route</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2 text-muted-foreground">{fmt(row.created_at)}</td>
              <td className="px-3 py-2">
                <Pill value={row.access_decision ?? "unknown"} />
                <p className="mt-1 text-muted-foreground">{row.access_source ?? "-"}</p>
              </td>
              <td className="px-3 py-2 font-mono">{shortUid(row.patient_uid)}</td>
              <td className="px-3 py-2">
                <p className="font-mono">{shortUid(row.actor_uid)}</p>
                <p className="text-muted-foreground">{row.actor_role ?? "-"}</p>
              </td>
              <td className="px-3 py-2">
                <p>{row.record_type ?? "-"}</p>
                <p className="text-muted-foreground">{row.resource_type ?? row.policy_code ?? "-"}</p>
              </td>
              <td className="px-3 py-2 font-mono">
                {row.action ?? "VIEW"} {row.route ?? "-"}
              </td>
              <td className="px-3 py-2">{row.access_reason ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
