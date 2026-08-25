"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  cssdIssueTransitions,
  listCssdIssues,
  type CssdIssue,
} from "@/lib/api/cssd";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { StatusPill, fmtDate, humanize, inputClass } from "./helpers";
import {
  IssueActionDialog,
  IssueSetDialog,
  issueTransitionLabel,
} from "./IssueActions";

/** Mirror of the issue statuses set_issue_log rows move through. */
const ISSUE_STATUSES = [
  "issued",
  "in_theatre",
  "returned",
  "awaiting_sterilization",
  "sterilized",
  "sterilization_failed",
  "cancelled",
];

export function IssuesTab() {
  const [status, setStatus] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [action, setAction] = useState<{
    issue: CssdIssue;
    transition: string;
  } | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["cssd", "issues", { status }],
    queryFn: () => listCssdIssues({ status: status || undefined, limit: 200 }),
  });

  const issues = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Status
          </span>
          <select
            className={inputClass}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {ISSUE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setIssuing(true)}
            className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Issue set
          </button>
        </div>
      </div>

      {isLoading && <LoadingSpinner label="Loading CSSD issues" />}

      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error.message}
        </div>
      )}

      {!isLoading && !error && issues.length === 0 && (
        <div className="rounded-lg border border-border">
          <EmptyState
            title="No instrument sets issued"
            description="Issuing a set against an OT case is what makes the theatre sterility warnings appear."
          />
        </div>
      )}

      {!isLoading && !error && issues.length > 0 && (
        <IssueTable
          rows={issues}
          onAction={(issue, transition) => setAction({ issue, transition })}
        />
      )}

      {issuing && <IssueSetDialog onClose={() => setIssuing(false)} />}
      {action && (
        <IssueActionDialog
          issue={action.issue}
          transition={action.transition}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}

export function IssueTable({
  rows,
  onAction,
}: {
  rows: CssdIssue[];
  onAction: (issue: CssdIssue, transition: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="p-3 text-left">Set</th>
            <th className="p-3 text-left">OT case</th>
            <th className="p-3 text-left">Status</th>
            <th className="p-3 text-left">Return due</th>
            <th className="p-3 text-left">Warnings</th>
            <th className="p-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((issue) => {
            const transitions = cssdIssueTransitions(issue.status);
            return (
              <tr key={issue.id} className="border-t border-border">
                <td className="p-3">
                  <div className="font-medium">{issue.set_code}</div>
                  <div className="text-xs text-muted-foreground">
                    {issue.set_name}
                  </div>
                  {/* The issue code is what the transition dialogs and toasts
                      name, so it has to be readable on the row too. */}
                  <div className="font-mono text-xs text-muted-foreground">
                    {issue.issue_code}
                  </div>
                </td>
                <td className="p-3">
                  <div>{issue.procedure_name ?? "-"}</div>
                  <div className="text-xs text-muted-foreground">
                    {issue.ot_room ?? "No room"} {fmtDate(issue.scheduled_date)}
                  </div>
                </td>
                <td className="p-3">
                  <StatusPill status={issue.status} />
                </td>
                <td className="p-3 text-xs">{fmtDate(issue.return_due_at)}</td>
                <td className="p-3 text-xs">
                  {(issue.issue_warning_codes ?? []).length > 0
                    ? issue.issue_warning_codes?.join(", ")
                    : "-"}
                </td>
                <td className="p-3">
                  {transitions.length === 0 ? (
                    <span className="block text-right text-xs text-muted-foreground">
                      Closed
                    </span>
                  ) : (
                    <div className="flex flex-wrap justify-end gap-1">
                      {transitions.map((transition) => (
                        <button
                          key={transition}
                          type="button"
                          onClick={() => onAction(issue, transition)}
                          className={`rounded border px-2 py-1 text-xs font-medium hover:bg-muted ${
                            transition === "cancelled"
                              ? "border-rose-500/40 text-rose-700 dark:text-rose-300"
                              : "border-border"
                          }`}
                        >
                          {issueTransitionLabel(transition)}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
