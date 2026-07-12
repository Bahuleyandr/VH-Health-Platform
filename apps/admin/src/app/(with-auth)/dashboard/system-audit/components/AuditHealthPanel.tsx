"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Ban,
  Clock3,
  Database,
  Download,
  Link2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserSearch,
} from "lucide-react";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { getAuditHealth } from "../auditWorkspaceApi";

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function percentage(value: unknown): string {
  const direct = numericValue(value);
  if (direct !== null) return `${direct.toFixed(direct % 1 === 0 ? 0 : 1)}%`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const candidate = numericValue(row.percentage ?? row.percent ?? row.coverage_percent);
    if (candidate !== null) return `${candidate.toFixed(candidate % 1 === 0 ? 0 : 1)}%`;
  }
  return "—";
}

function completenessMetric(
  value: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!value) return null;
  for (const key of keys) {
    const result = numericValue(value[key]);
    if (result !== null) return result;
  }
  return null;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.toLocaleString("en-IN")} · ${date.toISOString()}`;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function AuditHealthPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-audit-health"],
    queryFn: getAuditHealth,
  });

  if (isLoading) return <LoadingSpinner label="Checking audit health…" />;
  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error.message}
      </div>
    );
  }
  if (!data) return null;

  const actorAttributed = completenessMetric(data.completeness, ["actor_attributed"]);
  const patientAttributed = completenessMetric(data.completeness, ["patient_attributed"]);
  const requestCorrelated = completenessMetric(data.completeness, ["request_correlated"]);
  const totalEvents = data.total_events ?? completenessMetric(data.completeness, ["total_events", "total"]);
  const canonicalCoverage = typeof data.canonical_write_coverage === "number"
    ? data.canonical_write_coverage
    : numericValue(data.canonical_write_coverage?.coverage_percent);
  const orphanCount = data.resource_completeness.reduce(
    (total, resource) => total + resource.orphan_resource_rows,
    0,
  );
  const danglingCount = data.resource_completeness.reduce(
    (total, resource) => total + resource.dangling_audit_events,
    0,
  );
  const integrityProblemCount = data.integrity
    ? data.integrity.missing_hash_count
      + data.integrity.hash_mismatch_count
      + data.integrity.continuity_break_count
    : 0;
  const anomalyReviewCount = data.anomalies
    ? data.anomalies.denied_attempts
      + data.anomalies.break_glass_accesses
      + data.anomalies.after_hours_accesses
      + data.anomalies.high_patient_access_actors
    : 0;
  const sourceGapCount = data.sources.reduce(
    (total, source) => total + (source.missing_actor_count ?? 0) + (source.missing_request_id_count ?? 0),
    0,
  );
  const integrityWarning = !data.integrity || !data.integrity.intact;
  const hasWarning = integrityWarning
    || orphanCount > 0
    || danglingCount > 0
    || anomalyReviewCount > 0
    || sourceGapCount > 0
    || (canonicalCoverage !== null && canonicalCoverage < 100);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-gray-200 bg-card p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <ShieldCheck className="h-5 w-5 text-green-600" /> Audit health
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Coverage, attribution, source freshness, and integrity signals for the current tenant.
          </p>
          <p className="mt-1 text-xs text-gray-400">Generated {formatTime(data.generated_at)}</p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh health
        </button>
      </div>

      <div
        role="status"
        className={`flex items-start gap-3 rounded-lg border p-4 ${hasWarning
          ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
          : "border-green-300 bg-green-50 text-green-950 dark:border-green-700 dark:bg-green-950/30 dark:text-green-100"
        }`}
      >
        {hasWarning ? <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />}
        <div>
          <p className="font-semibold">{hasWarning ? "Audit health requires attention" : "Audit evidence is healthy"}</p>
          <p className="mt-1 text-sm opacity-80">
            {hasWarning
              ? `${integrityProblemCount || (data.integrity ? 0 : 1)} integrity issue(s), ${orphanCount} orphan resource(s), ${danglingCount} dangling event(s), ${sourceGapCount} source attribution gap(s), and ${anomalyReviewCount} access signal(s) need review.`
              : "The hash chain is intact, canonical resources are covered, and no review-level access signals were found."}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: "Events in window", value: totalEvents?.toLocaleString() ?? "—", icon: Activity, color: "text-blue-600" },
          { label: "Actor attributed", value: actorAttributed?.toLocaleString() ?? "—", icon: ShieldCheck, color: "text-green-600" },
          { label: "Patient attributed", value: patientAttributed?.toLocaleString() ?? "—", icon: Activity, color: "text-blue-600" },
          { label: "Request correlated", value: requestCorrelated?.toLocaleString() ?? "—", icon: Link2, color: "text-amber-600" },
          { label: "Canonical write coverage", value: percentage(data.canonical_write_coverage), icon: Database, color: "text-purple-600" },
        ].map((metric) => (
          <div key={metric.label} className="rounded-lg border border-gray-200 bg-card p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <metric.icon className={`h-4 w-4 ${metric.color}`} />
            <p className="mt-3 text-2xl font-semibold text-gray-900 dark:text-white">{metric.value}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{metric.label}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_1.9fr]">
        <section className="rounded-lg border border-gray-200 bg-card p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Clinical hash-chain integrity</h4>
              <p className="mt-1 text-xs text-gray-500">Tamper and continuity verification across canonical clinical events.</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${data.integrity?.intact
              ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
              : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
            }`}>
              {data.integrity?.intact ? "Hash chain verified" : "Hash chain requires attention"}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              { label: "Missing hashes", value: data.integrity?.missing_hash_count },
              { label: "Hash mismatches", value: data.integrity?.hash_mismatch_count },
              { label: "Broken links", value: data.integrity?.continuity_break_count },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-md bg-gray-50 p-3 dark:bg-gray-900/40">
                <p className={`text-xl font-semibold ${(value ?? 0) > 0 ? "text-red-700 dark:text-red-300" : "text-gray-900 dark:text-white"}`}>{value ?? "—"}</p>
                <p className="mt-1 text-xs text-gray-500">{label}</p>
              </div>
            ))}
          </div>
          {data.integrity?.first_problem_id || data.integrity?.first_missing_hash_id ? (
            <p className="mt-3 break-all rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
              First affected event: {data.integrity.first_problem_id ?? data.integrity.first_missing_hash_id}
              {data.integrity.first_problem_seq !== null ? ` · chain sequence ${data.integrity.first_problem_seq}` : ""}
            </p>
          ) : null}
        </section>

        <section className="rounded-lg border border-gray-200 bg-card p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Access signals requiring review</h4>
          <p className="mt-1 text-xs text-gray-500">
            After-hours means {data.anomalies?.after_hours_window ?? "20:00-07:00"} in {data.anomalies?.after_hours_timezone ?? "Asia/Kolkata"}.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-5">
            {[
              { label: "Denied attempts", value: data.anomalies?.denied_attempts, icon: Ban, warning: true },
              { label: "Break-glass", value: data.anomalies?.break_glass_accesses, icon: AlertTriangle, warning: true },
              { label: "After-hours", value: data.anomalies?.after_hours_accesses, icon: Clock3, warning: true },
              { label: "Audit exports", value: data.anomalies?.audit_exports, icon: Download, warning: false },
              { label: "Broad patient access", value: data.anomalies?.high_patient_access_actors, icon: UserSearch, warning: true },
            ].map((signal) => (
              <div key={signal.label} className="rounded-md border border-gray-100 p-3 dark:border-gray-700">
                <signal.icon className={`h-4 w-4 ${signal.warning && (signal.value ?? 0) > 0 ? "text-amber-600" : "text-gray-500"}`} />
                <p className="mt-2 text-xl font-semibold tabular-nums text-gray-900 dark:text-white">{signal.value ?? "—"}</p>
                <p className="mt-1 text-xs text-gray-500">{signal.label}</p>
              </div>
            ))}
          </div>
          {data.anomalies?.high_patient_access_actor_details.length ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="text-left uppercase text-gray-500">
                  <tr><th className="pb-2">Actor</th><th className="pb-2">Role</th><th className="pb-2 text-right">Patients</th><th className="pb-2 text-right">Access events</th></tr>
                </thead>
                <tbody>
                  {data.anomalies.high_patient_access_actor_details.map((actor) => (
                    <tr key={actor.actor_uid} className="border-t border-gray-100 dark:border-gray-700">
                      <td className="py-2 font-mono">{actor.actor_uid}</td>
                      <td className="py-2">{actor.actor_role ?? "—"}</td>
                      <td className="py-2 text-right tabular-nums">{actor.distinct_patient_count}</td>
                      <td className="py-2 text-right tabular-nums">{actor.access_event_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-gray-500">Threshold: {data.anomalies.high_patient_access_threshold} distinct patients in the selected window.</p>
            </div>
          ) : null}
        </section>
      </div>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-card shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Canonical resource completeness</h4>
          <p className="mt-1 text-xs text-gray-500">Detail rows must have a matching canonical clinical audit event; audit events must still resolve to their source row.</p>
        </div>
        {data.resource_completeness.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">Resource completeness was not returned by the backend.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-700/60 dark:text-gray-300">
                <tr><th className="px-4 py-2 text-left">Resource</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Coverage</th><th className="px-4 py-2 text-right">Rows</th><th className="px-4 py-2 text-right">Audited</th><th className="px-4 py-2 text-right">Orphans</th><th className="px-4 py-2 text-right">Dangling events</th></tr>
              </thead>
              <tbody>
                {data.resource_completeness.map((resource) => {
                  const warning = resource.orphan_resource_rows > 0 || resource.dangling_audit_events > 0;
                  return (
                    <tr key={resource.resource_table} className="border-t border-gray-100 dark:border-gray-700">
                      <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">{humanize(resource.resource_table)}</td>
                      <td className="px-4 py-3"><span className={`rounded px-2 py-0.5 text-xs font-medium ${warning ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>{warning ? "Review gaps" : "Complete"}</span></td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{percentage(resource.coverage_percent)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{resource.resource_rows.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{resource.audited_resource_rows.toLocaleString()}</td>
                      <td className={`px-4 py-3 text-right tabular-nums ${resource.orphan_resource_rows > 0 ? "font-semibold text-amber-700" : ""}`}>{resource.orphan_resource_rows.toLocaleString()}</td>
                      <td className={`px-4 py-3 text-right tabular-nums ${resource.dangling_audit_events > 0 ? "font-semibold text-red-700" : ""}`}>{resource.dangling_audit_events.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-card shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Audit source status</h4>
        </div>
        {data.sources.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No source-level health information was returned.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-700/60 dark:text-gray-300">
                <tr><th className="px-4 py-2 text-left">Source</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Events</th><th className="px-4 py-2 text-right">Missing actor</th><th className="px-4 py-2 text-right">Missing request ID</th><th className="px-4 py-2 text-left">Last event</th></tr>
              </thead>
              <tbody>
                {data.sources.map((source) => {
                  const sourceWarning = (source.missing_actor_count ?? 0) > 0 || (source.missing_request_id_count ?? 0) > 0;
                  return (
                    <tr key={source.source} className="border-t border-gray-100 dark:border-gray-700">
                      <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">{humanize(source.source)}</td>
                      <td className="px-4 py-3"><span className={`rounded px-2 py-0.5 text-xs font-medium ${sourceWarning ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>{sourceWarning ? "Attribution gaps" : source.status || "Active"}</span></td>
                      <td className="px-4 py-3 text-right tabular-nums">{source.event_count?.toLocaleString() ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{source.missing_actor_count?.toLocaleString() ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{source.missing_request_id_count?.toLocaleString() ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{formatTime(source.last_event_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
