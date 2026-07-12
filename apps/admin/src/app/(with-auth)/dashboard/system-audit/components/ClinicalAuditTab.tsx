"use client";

// Clinical Audit tab — the first admin surface over the backend's unified
// audit feed (GET /api/v1/admin/audit/unified), which UNIONs three sinks into
// one normalized, tenant-scoped stream:
//   - audit_log            → source "request"        (HTTP request audit)
//   - clinical_audit_events → source "clinical"      (in-transaction clinical actions)
//   - patient_access_audit_log → source "patient_access" (allow/deny/break-glass)
//
// The endpoint returns no total count, so next-page availability is inferred
// from a full page of rows (rows.length === PAGE_SIZE).

import React, { FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Search,
  SearchX,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api/core";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import type {
  UnifiedAuditResponse,
  UnifiedAuditRow,
  UnifiedAuditSource,
} from "../auditTypes";
import { fmtTime, truncate } from "./auditHelpers";

const PAGE_SIZE = 25;

interface UnifiedAuditFilters {
  source: string;
  action: string;
  actor_uid: string;
  patient_uid: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: UnifiedAuditFilters = {
  source: "",
  action: "",
  actor_uid: "",
  patient_uid: "",
  from: "",
  to: "",
};

// Source legs exactly as the controller names them.
const SOURCE_META: Record<UnifiedAuditSource, { label: string; chip: string }> =
  {
    request: {
      label: "HTTP",
      chip: "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-300",
    },
    clinical: {
      label: "Clinical",
      chip: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
    },
    patient_access: {
      label: "Access",
      chip: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
    },
  };

function sourceChip(source: UnifiedAuditRow["source"]) {
  const meta = SOURCE_META[source] ?? {
    label: source,
    chip: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${meta.chip}`}
    >
      {meta.label}
    </span>
  );
}

// action_status differs per leg: request → success/failure, clinical → the
// event's action_status, patient_access → the access decision.
function statusPill(status: string | null) {
  const s = (status ?? "").toLowerCase();
  const cls = ["success", "allowed", "allow", "granted"].includes(s)
    ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    : ["failure", "failed", "denied", "deny", "error", "blocked"].includes(s)
      ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
      : s.includes("break")
        ? "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
        : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status || "—"}
    </span>
  );
}

function buildQuery(filters: UnifiedAuditFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.actor_uid.trim()) params.set("actor_uid", filters.actor_uid.trim());
  if (filters.patient_uid.trim())
    params.set("patient_uid", filters.patient_uid.trim());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(page * PAGE_SIZE));
  return params.toString();
}

const inputClass =
  "input-sm border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200";

export function ClinicalAuditTab() {
  const [draft, setDraft] = useState<UnifiedAuditFilters>(EMPTY_FILTERS);
  const [submitted, setSubmitted] = useState<UnifiedAuditFilters | null>(null);
  const [page, setPage] = useState(0);
  // Ids can collide across the three sinks, so the expand key includes the source.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const queryString = submitted === null ? null : buildQuery(submitted, page);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-unified-audit", queryString],
    queryFn: () =>
      fetchAdminAPI<UnifiedAuditResponse>(
        `/admin/audit/unified?${queryString ?? ""}`,
      ),
    enabled: queryString !== null,
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPage(0);
    setExpandedKey(null);
    setSubmitted({ ...draft });
  };

  const goToPage = (next: number) => {
    setPage(next);
    setExpandedKey(null);
  };

  const setDraftField =
    (field: keyof UnifiedAuditFilters) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setDraft((d) => ({ ...d, [field]: e.target.value }));

  const rows = data?.logs ?? [];
  const hasNextPage = rows.length === PAGE_SIZE;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <form
        aria-label="Clinical audit filters"
        onSubmit={handleSubmit}
        className="bg-card dark:bg-gray-800 rounded-lg p-4 shadow-sm"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <select
            aria-label="Filter by audit source"
            className={inputClass}
            value={draft.source}
            onChange={setDraftField("source")}
          >
            <option value="">All sources</option>
            <option value="request">HTTP requests</option>
            <option value="clinical">Clinical actions</option>
            <option value="patient_access">Access decisions</option>
          </select>

          <input
            type="text"
            aria-label="Filter by patient UID"
            placeholder="Patient UID"
            className={inputClass}
            value={draft.patient_uid}
            onChange={setDraftField("patient_uid")}
          />

          <input
            type="text"
            aria-label="Filter by actor UID"
            placeholder="Actor UID"
            className={inputClass}
            value={draft.actor_uid}
            onChange={setDraftField("actor_uid")}
          />

          <input
            type="text"
            aria-label="Filter by action"
            placeholder="Action contains…"
            className={inputClass}
            value={draft.action}
            onChange={setDraftField("action")}
          />

          <input
            type="date"
            aria-label="Events from date"
            className={inputClass}
            value={draft.from}
            onChange={setDraftField("from")}
          />

          <input
            type="date"
            aria-label="Events to date"
            className={inputClass}
            value={draft.to}
            onChange={setDraftField("to")}
          />

          <button
            type="submit"
            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
          >
            <Search className="h-4 w-4" />
            Search
          </button>
        </div>
      </form>

      {submitted === null ? (
        <div className="bg-card dark:bg-gray-800 rounded-lg shadow-sm">
          <EmptyState
            icon={<ClipboardList className="h-10 w-10 text-muted-foreground" />}
            title="Search the unified clinical audit feed"
            description="One tenant-scoped stream across HTTP request audit, in-transaction clinical actions, and patient-access decisions. Set filters and press Search."
          />
        </div>
      ) : isLoading ? (
        <LoadingSpinner label="Loading unified audit events…" />
      ) : error ? (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm"
        >
          {error.message}
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-card dark:bg-gray-800 rounded-lg shadow-sm">
          <EmptyState
            icon={<SearchX className="h-10 w-10 text-muted-foreground" />}
            title="No audit events found"
            description="No unified audit events match the current filters. Widen the date range or clear a filter and search again."
          />
        </div>
      ) : (
        <>
          {/* Pagination (the endpoint returns no total — a full page implies more) */}
          <div className="flex items-center justify-between text-sm text-gray-500">
            <span>
              Page {page + 1} · {rows.length} event{rows.length === 1 ? "" : "s"}
              {hasNextPage ? " · more available" : ""}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => goToPage(page - 1)}
                className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                ← Prev
              </button>
              <button
                type="button"
                disabled={!hasNextPage}
                onClick={() => goToPage(page + 1)}
                className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Next →
              </button>
            </div>
          </div>

          {/* Results table */}
          <div className="bg-card dark:bg-gray-800 rounded-lg shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[960px]">
              <thead className="bg-gray-50 dark:bg-gray-700 text-xs text-gray-500 dark:text-gray-400 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Time</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-left px-3 py-2">Actor</th>
                  <th className="text-left px-3 py-2">Patient</th>
                  <th className="text-left px-3 py-2">Action</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = `${row.source}-${row.id}`;
                  const expanded = expandedKey === key;
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className="border-b dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        onClick={() => setExpandedKey(expanded ? null : key)}
                      >
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                          <div className="flex items-center gap-1">
                            {expanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            {fmtTime(row.occurred_at)}
                          </div>
                        </td>
                        <td className="px-3 py-2">{sourceChip(row.source)}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-800 dark:text-gray-200 truncate max-w-[140px]">
                            {row.actor_uid || "—"}
                          </div>
                          {row.actor_role && (
                            <div className="text-xs text-gray-400">
                              {row.actor_role}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
                            {row.patient_uid || "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className="text-xs text-gray-600 dark:text-gray-400"
                            title={row.action ?? ""}
                          >
                            {truncate(row.action, 32)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {statusPill(row.action_status)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className="text-xs text-gray-500 dark:text-gray-400"
                            title={row.summary ?? ""}
                          >
                            {truncate(row.summary, 48)}
                          </span>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-gray-50 dark:bg-gray-900/40">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                              <div>
                                <span className="font-semibold text-gray-600 dark:text-gray-400">
                                  Event ID:{" "}
                                </span>
                                <span className="font-mono">{row.id}</span>
                              </div>
                              <div>
                                <span className="font-semibold text-gray-600 dark:text-gray-400">
                                  Resource:{" "}
                                </span>
                                <span>{row.resource_type || "—"}</span>
                                {row.resource_table && (
                                  <>
                                    {" · "}
                                    <span className="font-mono">
                                      {row.resource_table}
                                    </span>
                                  </>
                                )}
                                {row.resource_id && (
                                  <>
                                    {" · #"}
                                    <span className="font-mono">
                                      {row.resource_id}
                                    </span>
                                  </>
                                )}
                              </div>
                              <div>
                                <span className="font-semibold text-gray-600 dark:text-gray-400">
                                  Tenant:{" "}
                                </span>
                                <span className="font-mono">
                                  {row.tenant_id || "—"}
                                </span>
                              </div>
                              {row.metadata && (
                                <div className="md:col-span-3">
                                  <span className="font-semibold text-gray-600 dark:text-gray-400">
                                    Detail:
                                  </span>
                                  <pre className="mt-1 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all">
                                    {JSON.stringify(row.metadata, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
