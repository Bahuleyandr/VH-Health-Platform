"use client";

import { APIError } from "@/lib/api/core";
import {
  commitImportJob,
  getRehearsalReport,
  rehearseImportJob,
  type CommitResult,
  type MigrationFileInput,
  type MigrationImportJob,
  type MigrationMappingProfile,
  type MigrationValidationFinding,
} from "@/lib/api/migrationToolkit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { Hl7AdtPanel } from "./Hl7AdtPanel";
import { RehearsalReportView } from "./RehearsalReportView";
import {
  ConfirmDialog,
  JsonDetails,
  SectionCard,
  StatusPill,
  formatDateTime,
} from "./shared";
import { SourceFilesEditor, type EditableFile } from "./SourceFilesEditor";

function toApiFiles(files: EditableFile[]): MigrationFileInput[] {
  return files.map((file, index) => ({
    file_kind: file.file_kind,
    source_filename: file.source_filename.trim() || `source-${index + 1}.csv`,
    csv_text: file.csv_text,
    ...(file.mapping_profile_id
      ? { mapping_profile_id: Number(file.mapping_profile_id) }
      : {}),
  }));
}

export function JobWorkspace({
  job,
  profiles,
}: {
  job: MigrationImportJob;
  profiles: MigrationMappingProfile[];
}) {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<EditableFile[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(`commit-job-${job.id}`);
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false);
  const [lastCommit, setLastCommit] = useState<CommitResult | null>(null);
  const [lastFindings, setLastFindings] = useState<
    MigrationValidationFinding[] | undefined
  >(undefined);

  const reportQuery = useQuery({
    queryKey: ["migration-toolkit", "report", job.id],
    queryFn: () => getRehearsalReport(job.id),
    retry: false,
  });
  const reportMissing =
    reportQuery.error instanceof APIError && reportQuery.error.status === 404;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["migration-toolkit"] });

  const rehearseMutation = useMutation({
    mutationFn: () => rehearseImportJob(job.id, toApiFiles(files)),
    onSuccess: (result) => {
      setLastFindings(result.findings);
      toast.success(
        result.report.status === "blocked"
          ? "Rehearsal completed with blocking errors"
          : "Rehearsal report ready",
      );
      void invalidate();
    },
    onError: (err: Error) => toast.error(err.message || "Rehearsal failed"),
  });

  const commitMutation = useMutation({
    mutationFn: () =>
      commitImportJob(job.id, {
        files: toApiFiles(files),
        idempotency_key: idempotencyKey.trim() || undefined,
      }),
    onSuccess: (result) => {
      setLastCommit(result);
      setCommitConfirmOpen(false);
      toast.success(
        result.replayed
          ? "Idempotent replay: returning the earlier committed batch"
          : "Commit batch completed",
      );
      void invalidate();
    },
    onError: (err: Error) => {
      setCommitConfirmOpen(false);
      toast.error(err.message || "Commit failed");
    },
  });

  const report = reportQuery.data;
  const filesReady =
    files.length > 0 && files.every((file) => file.csv_text.trim().length > 0);
  const rehearsalBlocked = report?.status === "blocked";
  const commitReady = filesReady && !!report && !rehearsalBlocked;

  return (
    <div className="space-y-4">
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            Job #{job.id}: {job.job_name}
            <StatusPill value={job.status} />
          </span>
        }
      >
        <p className="text-sm text-muted-foreground">
          Two-phase contract: <strong>rehearsal</strong> is a dry run that only
          writes redacted evidence to the toolkit tables; <strong>commit</strong>{" "}
          is a separate, explicitly confirmed step that re-validates the same
          source files and then writes live rows. Nothing below commits until
          the commit confirmation is accepted.
        </p>

        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            Source files (used by both phases)
          </h3>
          <SourceFilesEditor files={files} onChange={setFiles} profiles={profiles} />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <button
            type="button"
            disabled={!filesReady || rehearseMutation.isPending}
            onClick={() => rehearseMutation.mutate()}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            <FlaskConical className="h-4 w-4" />
            {rehearseMutation.isPending ? "Rehearsing..." : "Run rehearsal (dry run)"}
          </button>

          <label className="block text-xs font-medium text-muted-foreground">
            <span>Commit idempotency key</span>
            <input
              aria-label="Commit idempotency key"
              className="mt-1 w-64 rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
            />
          </label>

          <button
            type="button"
            disabled={!commitReady || commitMutation.isPending}
            onClick={() => setCommitConfirmOpen(true)}
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            <ShieldAlert className="h-4 w-4" />
            Commit to live tables...
          </button>
          {!report && !reportQuery.isLoading && (
            <span className="text-xs text-muted-foreground">
              Run a rehearsal first — commit stays disabled until a rehearsal
              report exists.
            </span>
          )}
          {rehearsalBlocked && (
            <span className="text-xs text-red-700">
              Rehearsal is blocked by error-severity findings; fix the source
              data and rehearse again.
            </span>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Latest rehearsal report">
        {reportQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading report...</p>
        ) : reportMissing ? (
          <p className="text-sm text-muted-foreground">
            No rehearsal report yet for this job.
          </p>
        ) : reportQuery.error instanceof Error ? (
          <p className="text-sm text-red-700">{reportQuery.error.message}</p>
        ) : report ? (
          <RehearsalReportView report={report} findings={lastFindings} />
        ) : null}
      </SectionCard>

      {lastCommit && (
        <SectionCard title="Commit result">
          <div className="space-y-3" data-testid="commit-result">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <StatusPill value={lastCommit.batch.status} />
              <span className="text-xs text-muted-foreground">
                Batch #{lastCommit.batch.id} · key{" "}
                <span className="font-mono">{lastCommit.batch.idempotency_key}</span>
              </span>
              {lastCommit.replayed && (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                  idempotent replay — no new writes
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                Committed {formatDateTime(lastCommit.batch.committed_at)}
              </span>
            </div>
            {lastCommit.report && (
              <div className="grid gap-2 sm:grid-cols-2">
                <JsonDetails
                  label="Acceptance summary"
                  value={lastCommit.report.acceptance_summary}
                />
                <JsonDetails
                  label="Opening balance totals"
                  value={lastCommit.report.opening_balance_totals}
                />
                <JsonDetails label="Replay proof" value={lastCommit.report.replay_proof} />
                <JsonDetails
                  label="Rollback proof (operator review required)"
                  value={lastCommit.report.rollback_proof ?? null}
                />
              </div>
            )}
          </div>
        </SectionCard>
      )}

      <Hl7AdtPanel job={job} />

      {commitConfirmOpen && (
        <ConfirmDialog
          destructive
          title="Commit migration to live tables?"
          body={
            <>
              <p>
                This is <strong>phase 2 of the two-phase contract</strong>. The
                rehearsal was a dry run; confirming here writes migrated
                patients, encounters, and opening-AR rows into this tenant&apos;s
                live authoritative tables.
              </p>
              <p>
                The same source files are re-submitted and re-validated — any
                error-severity finding blocks the entire commit. The batch runs
                under idempotency key{" "}
                <span className="font-mono">{idempotencyKey.trim() || `job-${job.id}-csv`}</span>;
                replaying the same key returns the earlier batch instead of
                writing twice.
              </p>
              <p>
                An acceptance report with rollback proof is generated; rollback
                itself requires operator review.
              </p>
            </>
          }
          confirmLabel="Commit batch"
          pending={commitMutation.isPending}
          onConfirm={() => commitMutation.mutate()}
          onCancel={() => setCommitConfirmOpen(false)}
        />
      )}
    </div>
  );
}
