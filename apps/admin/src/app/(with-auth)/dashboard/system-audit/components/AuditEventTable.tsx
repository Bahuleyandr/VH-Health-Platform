"use client";

import { ChevronRight, ShieldAlert } from "lucide-react";
import type { AuditEvent } from "../auditTypes";

interface AuditEventTableProps {
  events: AuditEvent[];
  displayTimezone: string;
  onSelect: (event: AuditEvent) => void;
}

const sourceClasses: Record<string, string> = {
  clinical: "bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-200",
  request: "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200",
  patient_access:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200",
  domain: "bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-200",
};

function humanize(value: string | null): string {
  if (!value) return "—";
  return value.replaceAll("_", " ").replaceAll(".", " · ");
}

function maskPatientName(name: string | null): string | null {
  if (!name) return null;
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1)}${"•".repeat(Math.min(4, Math.max(1, part.length - 1)))}`)
    .join(" ");
}

function formatTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: timezone,
  }).format(date);
}

function utcTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "UTC unavailable";
  return date.toISOString().replace("T", " ");
}

function outcomeClasses(outcome: string | null): string {
  const normalized = (outcome ?? "").toLowerCase();
  if (["success", "allowed", "allow", "completed"].includes(normalized)) {
    return "bg-green-100 text-green-800 dark:bg-green-900/60 dark:text-green-200";
  }
  if (["failure", "failed", "denied", "error", "blocked"].includes(normalized)) {
    return "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200";
  }
  if (normalized.includes("break")) {
    return "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200";
  }
  return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";
}

export function AuditEventTable({
  events,
  displayTimezone,
  onSelect,
}: AuditEventTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-card shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <table className="w-full min-w-[1120px] text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-700/70 dark:text-gray-300">
          <tr>
            <th className="px-3 py-3 text-left">Date and time</th>
            <th className="px-3 py-3 text-left">Staff / doctor</th>
            <th className="px-3 py-3 text-left">Patient</th>
            <th className="px-3 py-3 text-left">Action</th>
            <th className="px-3 py-3 text-left">Resource</th>
            <th className="px-3 py-3 text-left">Outcome</th>
            <th className="px-3 py-3 text-left">Source</th>
            <th className="w-12 px-3 py-3"><span className="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const patientName = maskPatientName(event.patient_name);
            const eventKey = `${event.source}:${event.id}`;
            return (
              <tr
                key={eventKey}
                className="border-t border-gray-100 hover:bg-gray-50/80 dark:border-gray-700 dark:hover:bg-gray-700/40"
              >
                <td className="whitespace-nowrap px-3 py-3 align-top">
                  <div className="font-medium text-gray-800 dark:text-gray-100">
                    {formatTime(event.occurred_at, displayTimezone)}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-gray-400">
                    {utcTime(event.occurred_at)}
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="font-medium text-gray-800 dark:text-gray-100">
                    {event.actor_name || event.actor_uid || "System / unknown"}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {humanize(event.actor_role)}
                    {event.actor_uid && event.actor_name ? ` · ${event.actor_uid}` : ""}
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="font-mono text-xs text-gray-700 dark:text-gray-200">
                    {event.patient_uid || "Not patient-scoped"}
                  </div>
                  {patientName ? (
                    <div className="mt-0.5 text-xs text-gray-400" title="Patient name masked in the audit table">
                      {patientName}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="font-medium text-gray-800 dark:text-gray-100">
                    {humanize(event.action)}
                  </div>
                  {event.summary ? (
                    <div className="mt-0.5 max-w-[260px] truncate text-xs text-gray-500 dark:text-gray-400" title={event.summary}>
                      {event.summary}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 align-top text-xs text-gray-600 dark:text-gray-300">
                  <div>{humanize(event.resource_type)}</div>
                  {event.resource_id ? (
                    <div className="mt-0.5 max-w-[150px] truncate font-mono text-gray-400" title={event.resource_id}>
                      {event.resource_id}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 align-top">
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${outcomeClasses(event.outcome)}`}>
                    {humanize(event.outcome)}
                  </span>
                  {event.integrity_status && event.integrity_status !== "verified" ? (
                    <div className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                      <ShieldAlert className="h-3 w-3" />
                      {humanize(event.integrity_status)}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 align-top">
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${sourceClasses[event.source] ?? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"}`}>
                    {humanize(event.source)}
                  </span>
                </td>
                <td className="px-3 py-3 align-top">
                  <button
                    type="button"
                    aria-label={`View details for ${event.action}`}
                    onClick={() => onSelect(event)}
                    className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:hover:bg-gray-700"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
