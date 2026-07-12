"use client";

/**
 * Audit log search tab. Structured filters over the backend's
 * GET /compliance/audit/search (tenant-scoped `audit_log` table):
 * patient_uid, staff_uid, action, module, date range — paginated.
 * Self-contained query state.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";

import type { AuditSearchResult } from "./types";
import { fmtDate, unwrap } from "./shared";

const PAGE_SIZE = 50;

interface AuditFilters {
  patient_uid: string;
  staff_uid: string;
  action: string;
  module: string;
  date_from: string;
  date_to: string;
}

const EMPTY_FILTERS: AuditFilters = {
  patient_uid: "",
  staff_uid: "",
  action: "",
  module: "",
  date_from: "",
  date_to: "",
};

const FILTER_FIELDS: Array<{
  key: keyof AuditFilters;
  label: string;
  placeholder: string;
  type: "text" | "date";
}> = [
  { key: "patient_uid", label: "Patient UID", placeholder: "patient_uid", type: "text" },
  { key: "staff_uid", label: "Staff UID", placeholder: "staff_uid (user id)", type: "text" },
  { key: "action", label: "Action", placeholder: "action (e.g. create_clinical_note)", type: "text" },
  { key: "module", label: "Module", placeholder: "module (e.g. emr, billing)", type: "text" },
  { key: "date_from", label: "From date", placeholder: "", type: "date" },
  { key: "date_to", label: "To date", placeholder: "", type: "date" },
];

function buildQueryString(filters: AuditFilters, page: number): string {
  const params = new URLSearchParams();
  for (const { key } of FILTER_FIELDS) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  params.set("page", String(page));
  params.set("limit", String(PAGE_SIZE));
  return params.toString();
}

export function AuditTab() {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [submitted, setSubmitted] = useState<{ filters: AuditFilters; page: number } | null>(null);

  const {
    data: results,
    isLoading,
    isError,
    error,
  } = useQuery<AuditSearchResult[]>({
    queryKey: ["compliance-audit-search", submitted],
    queryFn: async () => {
      if (!submitted) return [];
      const res = await fetchAdminAPI<unknown>(
        `/compliance/audit/search?${buildQueryString(submitted.filters, submitted.page)}`,
      );
      return unwrap<AuditSearchResult[]>(res) ?? [];
    },
    enabled: submitted !== null,
  });

  const runSearch = () => setSubmitted({ filters: draft, page: 1 });
  const page = submitted?.page ?? 1;
  const onLastPage = (results?.length ?? 0) < PAGE_SIZE;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {FILTER_FIELDS.map((field) => (
          <input
            key={field.key}
            type={field.type}
            aria-label={field.label}
            placeholder={field.placeholder}
            value={draft[field.key]}
            onChange={(e) => setDraft((current) => ({ ...current, [field.key]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        ))}
      </div>
      <button
        onClick={runSearch}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <Search className="h-4 w-4" />
        Search
      </button>

      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error instanceof Error ? error.message : "Failed to search audit logs"}
        </div>
      )}

      {isLoading && <LoadingSpinner label="Searching audit log" />}

      {!submitted && (
        <EmptyState
          icon={<Search className="h-10 w-10 text-muted-foreground" />}
          title="Search the audit log"
          description="Filter by patient UID, staff UID, action, module, or date range — or leave everything blank to see the latest activity."
          compact
        />
      )}

      {submitted && !isLoading && !isError && results && results.length === 0 && (
        <EmptyState
          icon={<FileText className="h-10 w-10 text-muted-foreground" />}
          title="No audit entries found"
          description="No audit entries match these filters."
          compact
        />
      )}

      {results && results.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Timestamp</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Action</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">User</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Resource</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">IP</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {results.map((entry) => (
                <tr key={entry.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtDate(entry.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{entry.action}</p>
                    <p className="text-xs text-muted-foreground">{entry.module ?? "—"}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p>{entry.user_name ?? entry.user_id ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{entry.user_role ?? "—"}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <p>
                      {entry.resource
                        ? entry.resource_id
                          ? `${entry.resource}/${entry.resource_id}`
                          : entry.resource
                        : "—"}
                    </p>
                    <p className="font-mono text-xs max-w-[16rem] truncate">
                      {entry.method ?? ""} {entry.path ?? ""}
                    </p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{entry.ip_address ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs">
                    <p className="truncate">{entry.request_summary ?? "—"}</p>
                    {entry.status_code != null && (
                      <p className={entry.success === false ? "text-red-600" : ""}>
                        HTTP {entry.status_code}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {submitted && !isLoading && !isError && results && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Page {page}</span>
          <div className="flex gap-2">
            <button
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setSubmitted((current) => (current ? { ...current, page: current.page - 1 } : current))}
              className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Previous page
            </button>
            <button
              aria-label="Next page"
              disabled={onLastPage}
              onClick={() => setSubmitted((current) => (current ? { ...current, page: current.page + 1 } : current))}
              className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Next page
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default AuditTab;
