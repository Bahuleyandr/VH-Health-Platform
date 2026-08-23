"use client";

import { EmptyState } from "@/components/EmptyState";
import {
  IMPORT_KINDS,
  createImportJob,
  type ImportKind,
  type MigrationImportJob,
} from "@/lib/api/migrationToolkit";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { SectionCard, StatusPill, formatDateTime } from "./shared";

export function JobsPanel({
  jobs,
  selectedJobId,
  onSelect,
}: {
  jobs: MigrationImportJob[];
  selectedJobId: number | null;
  onSelect: (jobId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [jobName, setJobName] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  const [importKind, setImportKind] = useState<ImportKind>("mixed");

  const createMutation = useMutation({
    mutationFn: () =>
      createImportJob({
        job_name: jobName.trim(),
        source_system: sourceSystem.trim() || null,
        import_kind: importKind,
      }),
    onSuccess: (job) => {
      toast.success(`Import job #${job.id} created`);
      setCreating(false);
      setJobName("");
      setSourceSystem("");
      void queryClient.invalidateQueries({ queryKey: ["migration-toolkit"] });
      onSelect(job.id);
    },
    onError: (err: Error) => toast.error(err.message || "Job creation failed"),
  });

  return (
    <SectionCard
      title="Import jobs"
      actions={
        <button
          type="button"
          onClick={() => setCreating((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
        >
          <Plus className="h-3 w-3" />
          New job
        </button>
      }
    >
      {creating && (
        <div className="mb-4 grid gap-3 rounded-md border border-border bg-background p-3 sm:grid-cols-4">
          <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">
            <span>Job name</span>
            <input
              aria-label="Job name"
              className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
              value={jobName}
              onChange={(e) => setJobName(e.target.value)}
              placeholder="Legacy HIS cutover wave 1"
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            <span>Source system</span>
            <input
              aria-label="Source system"
              className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
              value={sourceSystem}
              onChange={(e) => setSourceSystem(e.target.value)}
              placeholder="legacy-his"
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            <span>Import kind</span>
            <select
              className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
              value={importKind}
              onChange={(e) => setImportKind(e.target.value as ImportKind)}
            >
              {IMPORT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-4">
            <button
              type="button"
              disabled={createMutation.isPending || !jobName.trim()}
              onClick={() => createMutation.mutate()}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {createMutation.isPending ? "Creating..." : "Create job"}
            </button>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <EmptyState
          compact
          title="No import jobs"
          description="Create a job to start a rehearsal-first legacy data import."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Rows</th>
                <th className="px-3 py-2">Authoritative writes</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className={selectedJobId === job.id ? "bg-muted/40" : undefined}
                >
                  <td className="px-3 py-3">
                    <div className="font-medium text-foreground">{job.job_name}</div>
                    <div className="font-mono text-xs text-muted-foreground">#{job.id}</div>
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {job.source_system ?? "-"}
                  </td>
                  <td className="px-3 py-3 text-xs">{job.import_kind.replace(/_/g, " ")}</td>
                  <td className="px-3 py-3">
                    <StatusPill value={job.status} />
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {job.row_counts?.total ?? "-"}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {job.authoritative_write_enabled ? (
                      <span className="text-red-700">enabled (committed)</span>
                    ) : (
                      <span className="text-emerald-700">dry-run only</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(job.updated_at)}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onSelect(job.id)}
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
