// src/app/(with-auth)/dashboard/ward-indents/page.tsx
//
// Ward-indent pharmacy worklist (backend PR #935 state machine).
//
// Thin orchestrator per the god-page pattern: filters + list + detail modal.
// All contract knowledge lives in src/lib/api/wardIndents.ts and the action
// catalogue in components/helpers.tsx. Indent CREATION is deliberately absent:
// ward nursing staff raise indents from the staff app / IPD surface; this
// console is the pharmacy/decision worklist.

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  listWardIndents,
  WARD_INDENT_STATUSES,
  type WardIndent,
  type WardIndentStatus,
} from "@/lib/api/wardIndents";
import { IndentDetailModal } from "./components/IndentDetailModal";
import { IndentTable } from "./components/IndentTable";

export default function WardIndentsPage() {
  const [status, setStatus] = useState<WardIndentStatus | "">("");
  const [wardId, setWardId] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: indents = [], isLoading } = useQuery<WardIndent[]>({
    queryKey: ["ward-indents", "list", status, wardId, overdueOnly],
    queryFn: () =>
      listWardIndents({
        status,
        ward_id: wardId ? Number(wardId) : "",
        overdue_only: overdueOnly,
      }),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Ward Indents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ward-to-pharmacy indent worklist: reserve, short-supply and
          substitution handling, controlled-drug handoff, issue, ward receipt,
          returns and reconciliation — every step audited and SLA-clocked.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Status:</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as WardIndentStatus | "")}
            className="rounded border border-border bg-background px-2 py-1"
            data-testid="ward-indent-status-filter"
          >
            <option value="">All</option>
            {WARD_INDENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Ward id:</span>
          <input
            type="number"
            value={wardId}
            onChange={(e) => setWardId(e.target.value)}
            className="w-24 rounded border border-border bg-background px-2 py-1"
            data-testid="ward-indent-ward-filter"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            data-testid="ward-indent-overdue-filter"
          />
          <span className="text-muted-foreground">SLA-breached only</span>
        </label>
      </div>

      {isLoading && <LoadingSpinner label="Loading ward indents…" />}
      {!isLoading && indents.length === 0 && (
        <EmptyState title="No ward indents in this view." />
      )}
      {!isLoading && indents.length > 0 && (
        <IndentTable indents={indents} onSelect={setSelectedId} />
      )}

      {selectedId != null && (
        <IndentDetailModal
          indentId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
