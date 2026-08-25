"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  CSSD_SET_STATUSES,
  listInstrumentSets,
  type CssdInstrumentSet,
} from "@/lib/api/cssd";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { StatusPill, fmtDate, humanize, inputClass } from "./helpers";
import { IssueSetDialog } from "./IssueActions";
import { NewSetDialog, SetLabelDialog } from "./SetActions";

export function SetsTab() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [labelFor, setLabelFor] = useState<CssdInstrumentSet | null>(null);
  const [issueFor, setIssueFor] = useState<CssdInstrumentSet | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["cssd", "sets", { status, search }],
    queryFn: () =>
      listInstrumentSets({
        status: status || undefined,
        q: search.trim() || undefined,
        limit: 200,
      }),
  });

  const sets = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
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
              {CSSD_SET_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {humanize(option)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Search
            </span>
            <input
              aria-label="Search"
              className={inputClass}
              value={search}
              placeholder="Set code, barcode or name"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
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
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New set
          </button>
        </div>
      </div>

      {isLoading && <LoadingSpinner label="Loading instrument sets" />}

      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error.message}
        </div>
      )}

      {!isLoading && !error && sets.length === 0 && (
        <div className="rounded-lg border border-border">
          <EmptyState
            title="No instrument sets"
            description="Create a set before recording sterilization loads or issuing to theatre."
          />
        </div>
      )}

      {!isLoading && !error && sets.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-3 text-left">Set</th>
                <th className="p-3 text-left">Specialty</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Usable</th>
                <th className="p-3 text-left">Last sterilized</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sets.map((set) => {
                const issuable =
                  ["available", "sterilized"].includes(set.status) &&
                  set.usable &&
                  !set.requires_reprocessing;
                return (
                  <tr key={set.id} className="border-t border-border">
                    <td className="p-3">
                      <div className="font-medium">{set.set_code}</div>
                      <div className="text-xs text-muted-foreground">
                        {set.display_name}
                        {set.storage_location
                          ? ` · ${set.storage_location}`
                          : ""}
                      </div>
                    </td>
                    <td className="p-3">{set.specialty ?? "-"}</td>
                    <td className="p-3">
                      <StatusPill status={set.status} />
                    </td>
                    <td className="p-3 text-xs">
                      {set.usable && !set.requires_reprocessing
                        ? "Yes"
                        : "Needs reprocessing"}
                    </td>
                    <td className="p-3 text-xs">
                      {fmtDate(set.last_sterilized_at)}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setLabelFor(set)}
                          className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Print label
                        </button>
                        {issuable && (
                          <button
                            type="button"
                            onClick={() => setIssueFor(set)}
                            className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Issue to OT
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && <NewSetDialog onClose={() => setCreating(false)} />}
      {labelFor && (
        <SetLabelDialog set={labelFor} onClose={() => setLabelFor(null)} />
      )}
      {issueFor && (
        <IssueSetDialog
          presetSetId={issueFor.id}
          onClose={() => setIssueFor(null)}
        />
      )}
    </div>
  );
}
