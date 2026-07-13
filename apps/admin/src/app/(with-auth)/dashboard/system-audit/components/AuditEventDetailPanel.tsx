"use client";

import { useQuery } from "@tanstack/react-query";
import { Clock3, FileDiff, ShieldCheck, X } from "lucide-react";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import type { AuditEvent } from "../auditTypes";
import { getAuditEventDetail } from "../auditWorkspaceApi";

interface AuditEventDetailPanelProps {
  event: AuditEvent;
  displayTimezone: string;
  onClose: () => void;
}

const sensitiveKeyPattern =
  /(authorization|cookie|password|secret|token|raw[_-]?payload|note[_-]?text|clinical[_-]?text|phone|email|address|date[_-]?of[_-]?birth|\bdob\b)/i;

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " · ");
}

function formatTime(value: string | null, timezone: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: timezone,
  }).format(date)} · ${date.toISOString()}`;
}

function safePrimitive(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  return "Structured value";
}

function SafeObject({ value }: { value: Record<string, unknown> | null }) {
  if (!value || Object.keys(value).length === 0) {
    return <p className="text-xs text-gray-400">No safe detail supplied.</p>;
  }

  return (
    <dl className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900/40">
      {Object.entries(value).map(([key, item]) => {
        const hidden = sensitiveKeyPattern.test(key);
        return (
          <div key={key} className="grid grid-cols-[minmax(120px,0.4fr)_1fr] gap-3 px-3 py-2 text-xs">
            <dt className="font-medium text-gray-500 dark:text-gray-400">
              {humanize(key)}
            </dt>
            <dd className="min-w-0 break-words font-mono text-gray-800 dark:text-gray-100">
              {hidden ? (
                <span className="font-sans text-gray-400">Redacted in admin view</span>
              ) : Array.isArray(item) ? (
                item.length === 0 ? "—" : item.map(safePrimitive).join(", ")
              ) : item && typeof item === "object" ? (
                <SafeObject value={item as Record<string, unknown>} />
              ) : (
                safePrimitive(item)
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function maskIp(value: string | null): string {
  if (!value) return "—";
  if (value.includes(".")) {
    const parts = value.split(".");
    return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.•••` : "Masked";
  }
  if (value.includes(":")) return `${value.split(":").slice(0, 3).join(":")}:••••`;
  return "Masked";
}

export function AuditEventDetailPanel({
  event,
  displayTimezone,
  onClose,
}: AuditEventDetailPanelProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-audit-event", event.source, event.id],
    queryFn: () => getAuditEventDetail(event.source, event.id),
  });
  const detail = data ?? event;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="Audit event details"
      className="fixed inset-y-0 right-0 z-40 w-full max-w-2xl overflow-y-auto border-l border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between border-b border-gray-200 bg-white px-5 py-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-blue-600 dark:text-blue-300">
            {humanize(event.source)} event
          </p>
          <h3 className="mt-1 truncate text-lg font-semibold text-gray-900 dark:text-white">
            {humanize(event.action)}
          </h3>
          <p className="mt-1 font-mono text-xs text-gray-400">{event.id}</p>
        </div>
        <button
          type="button"
          aria-label="Close event details"
          onClick={onClose}
          className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-5 p-5">
        <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <Clock3 className="h-4 w-4 text-blue-600" /> Event identity
          </div>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-gray-400">Occurred</dt><dd>{formatTime(detail.occurred_at, displayTimezone)}</dd></div>
            <div><dt className="text-xs text-gray-400">Recorded</dt><dd>{formatTime(detail.recorded_at, displayTimezone)}</dd></div>
            <div><dt className="text-xs text-gray-400">Actor</dt><dd>{detail.actor_name || detail.actor_uid || "System / unknown"}</dd></div>
            <div><dt className="text-xs text-gray-400">Role</dt><dd>{detail.actor_role ? humanize(detail.actor_role) : "—"}</dd></div>
            <div><dt className="text-xs text-gray-400">Patient UID</dt><dd className="font-mono">{detail.patient_uid || "Not patient-scoped"}</dd></div>
            <div><dt className="text-xs text-gray-400">Department</dt><dd className="font-mono">{detail.department_id || "—"}</dd></div>
            <div><dt className="text-xs text-gray-400">Encounter / admission</dt><dd className="font-mono">{detail.encounter_id || detail.admission_id || "—"}</dd></div>
            <div><dt className="text-xs text-gray-400">Resource</dt><dd>{detail.resource_type || "—"}{detail.resource_id ? ` · ${detail.resource_id}` : ""}</dd></div>
            <div><dt className="text-xs text-gray-400">Request ID</dt><dd className="break-all font-mono">{detail.request_id || "—"}</dd></div>
            <div><dt className="text-xs text-gray-400">Network</dt><dd className="font-mono">{maskIp(detail.ip_address)}</dd></div>
          </dl>
          {detail.summary ? (
            <div className="mt-3 rounded-md bg-gray-50 p-3 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">
              {detail.summary}
            </div>
          ) : null}
        </section>

        {isLoading ? <LoadingSpinner label="Loading safe event detail…" /> : null}
        {error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error.message}
          </div>
        ) : null}

        {data ? (
          <>
            <section>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                <FileDiff className="h-4 w-4 text-purple-600" /> Before and after
              </div>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <div><p className="mb-1 text-xs font-medium text-gray-500">Before</p><SafeObject value={data.before_state} /></div>
                <div><p className="mb-1 text-xs font-medium text-gray-500">After</p><SafeObject value={data.after_state} /></div>
              </div>
            </section>
            <section>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                <ShieldCheck className="h-4 w-4 text-green-600" /> Safe metadata
              </div>
              <SafeObject value={data.metadata} />
              {data.redactions.length > 0 ? (
                <p className="mt-2 text-xs text-gray-400">
                  {data.redactions.length} sensitive field{data.redactions.length === 1 ? " was" : "s were"} redacted by the audit API.
                </p>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </aside>
  );
}
