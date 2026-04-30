"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  ListTree,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "react-hot-toast";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import {
  type DischargeComposeChildRunRow,
  type DischargeComposeRunDetail,
  type DischargeComposeRunListItem,
  type DischargeComposeStatus,
  getDischargeCompose,
  isPaused,
  listDischargeCompose,
  resumeDischargeCompose,
  startDischargeCompose,
} from "@/lib/api/dischargeCompose";

const STATUS_FILTERS: Array<{ value: DischargeComposeStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const SAFETY_BAND_STYLES: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  low: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const STATUS_ICONS: Record<string, ReactNode> = {
  running: <Clock className="h-4 w-4 text-sky-500" />,
  paused: <PauseCircle className="h-4 w-4 text-amber-500" />,
  completed: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
  cancelled: <XCircle className="h-4 w-4 text-zinc-500" />,
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export default function DischargeComposePage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<DischargeComposeStatus | "all">("all");
  const [admissionIdInput, setAdmissionIdInput] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  // Recent compose runs.
  const runsQuery = useQuery({
    queryKey: ["discharge-compose", "list", statusFilter],
    queryFn: () =>
      listDischargeCompose({
        limit: 50,
        status: statusFilter === "all" ? undefined : statusFilter,
      }),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  // Detail of the currently-selected run.
  const detailQuery = useQuery({
    queryKey: ["discharge-compose", "detail", selectedRunId],
    queryFn: () => getDischargeCompose(selectedRunId as number),
    enabled: selectedRunId !== null,
    refetchOnWindowFocus: false,
  });

  // Start a fresh compose run.
  const startMutation = useMutation({
    mutationFn: (admissionId: number) => startDischargeCompose(admissionId),
    onSuccess: async (result) => {
      if (isPaused(result)) {
        toast(
          `Compose paused: ${result.pause_reason}. Run #${result.run_id} awaiting resume.`,
          { icon: "⏸" },
        );
        setSelectedRunId(result.run_id);
      } else {
        toast.success(
          `Compose ready (band ${result.overall_safety_band}). Generation #${
            result.compose_generation_id ?? "—"
          }.`,
        );
        // result has no run_id when completed inline; fall back to refetching
        // the list and selecting the latest top-level run.
      }
      setAdmissionIdInput("");
      await queryClient.invalidateQueries({ queryKey: ["discharge-compose", "list"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Compose failed to start");
    },
  });

  // Resume a paused compose run.
  const resumeMutation = useMutation({
    mutationFn: (runId: number) => resumeDischargeCompose(runId),
    onSuccess: async (outcome, runId) => {
      if (outcome.status === "completed") {
        toast.success(`Run #${runId} completed.`);
      } else if (outcome.status === "paused") {
        toast(`Run #${runId} paused again: ${outcome.pauseReason ?? "unknown reason"}.`, { icon: "⏸" });
      } else if (outcome.status === "failed") {
        toast.error(
          `Run #${runId} failed at ${outcome.error?.node ?? "unknown"}: ${
            outcome.error?.message ?? ""
          }`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["discharge-compose", "list"] });
      await queryClient.invalidateQueries({
        queryKey: ["discharge-compose", "detail", runId],
      });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Resume failed");
    },
  });

  function handleStart(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number.parseInt(admissionIdInput, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("Enter a valid admission ID");
      return;
    }
    startMutation.mutate(parsed);
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Discharge Compose</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Orchestrates medication reconciliation, aftercare, discharge readiness, and clinical
            coding subgraphs into a unified discharge package. Each component remains independently
            reviewable; the parent run rolls up safety flags.
          </p>
        </div>
        <button
          type="button"
          onClick={() => runsQuery.refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          <RefreshCw className={`h-4 w-4 ${runsQuery.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {/* Start a fresh compose */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">Start a fresh compose</h2>
        <form onSubmit={handleStart} className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            placeholder="Admission ID"
            value={admissionIdInput}
            onChange={(e) => setAdmissionIdInput(e.target.value)}
            className="w-48 rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={startMutation.isPending}
          />
          <button
            type="submit"
            disabled={startMutation.isPending || !admissionIdInput}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {startMutation.isPending ? "Starting…" : "Start compose"}
          </button>
        </form>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent runs list */}
        <section className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b p-3">
            <h2 className="text-sm font-medium">Recent runs</h2>
            <div className="flex gap-1">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setStatusFilter(filter.value)}
                  className={`rounded-md px-2 py-0.5 text-xs ${
                    statusFilter === filter.value
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent"
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[28rem] overflow-y-auto">
            {runsQuery.isLoading ? (
              <LoadingSpinner label="Loading runs…" />
            ) : runsQuery.error ? (
              <EmptyState
                icon={<AlertTriangle className="h-10 w-10 text-red-500" />}
                title="Failed to load runs"
                description={runsQuery.error instanceof Error ? runsQuery.error.message : "Unknown error"}
                compact
              />
            ) : runsQuery.data?.runs.length === 0 ? (
              <EmptyState
                icon={<ListTree className="h-10 w-10 text-muted-foreground" />}
                title="No compose runs yet"
                description="Start a fresh compose above to populate this list."
                compact
              />
            ) : (
              <ul className="divide-y">
                {runsQuery.data?.runs.map((run) => (
                  <RunListRow
                    key={run.id}
                    run={run}
                    selected={run.id === selectedRunId}
                    onSelect={() => setSelectedRunId(run.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Selected run detail */}
        <section className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b p-3">
            <h2 className="text-sm font-medium">
              {selectedRunId ? `Run #${selectedRunId}` : "Run detail"}
            </h2>
            {selectedRunId && detailQuery.data?.run.status === "paused" && (
              <button
                type="button"
                onClick={() => resumeMutation.mutate(selectedRunId)}
                disabled={resumeMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                <PlayCircle className="h-3.5 w-3.5" />
                {resumeMutation.isPending ? "Resuming…" : "Resume"}
              </button>
            )}
          </div>
          <div className="p-3">
            {!selectedRunId ? (
              <EmptyState
                icon={<ListTree className="h-10 w-10 text-muted-foreground" />}
                title="Select a run"
                description="Click a run on the left to inspect the parent + children tree."
                compact
              />
            ) : detailQuery.isLoading ? (
              <LoadingSpinner label="Loading detail…" />
            ) : detailQuery.error ? (
              <EmptyState
                icon={<AlertTriangle className="h-10 w-10 text-red-500" />}
                title="Failed to load run"
                description={detailQuery.error instanceof Error ? detailQuery.error.message : "Unknown error"}
                compact
              />
            ) : detailQuery.data ? (
              <RunDetail detail={detailQuery.data} />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------- subcomponents ----------------

function RunListRow({
  run,
  selected,
  onSelect,
}: {
  run: DischargeComposeRunListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = run.metadata as { overall_safety_band?: string; compose_children?: string[] };
  const band = meta?.overall_safety_band ?? null;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
          selected ? "bg-accent" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {STATUS_ICONS[run.status] ?? null}
          <div className="min-w-0">
            <div className="flex items-center gap-2 truncate font-medium">
              <span>Run #{run.id}</span>
              <span className="text-xs text-muted-foreground">
                · admission {run.admission_id ?? "—"}
              </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {formatDate(run.started_at)}
              {run.pause_reason ? ` · paused: ${run.pause_reason}` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {band ? <SafetyBadge band={band} /> : null}
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </button>
    </li>
  );
}

function RunDetail({ detail }: { detail: DischargeComposeRunDetail }) {
  const { run, children } = detail;
  const meta = run.metadata as {
    compose_children?: string[];
    overall_safety_band?: string;
    request_id?: string;
  };
  const result = run.result;

  return (
    <div className="space-y-4">
      {/* Parent header */}
      <div className="rounded-md border bg-muted/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            {STATUS_ICONS[run.status] ?? null}
            <span>{run.status.toUpperCase()}</span>
            {run.pause_reason && (
              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                {run.pause_reason}
              </span>
            )}
          </div>
          {meta?.overall_safety_band && <SafetyBadge band={meta.overall_safety_band} />}
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Admission</dt>
          <dd className="font-mono">{run.admission_id ?? "—"}</dd>
          <dt>Started</dt>
          <dd>{formatDate(run.started_at)}</dd>
          {run.completed_at && (
            <>
              <dt>Completed</dt>
              <dd>{formatDate(run.completed_at)}</dd>
            </>
          )}
          {run.failed_at && (
            <>
              <dt>Failed</dt>
              <dd>{formatDate(run.failed_at)}</dd>
            </>
          )}
          <dt>Compose generation</dt>
          <dd className="font-mono">{result?.compose_generation_id ?? "—"}</dd>
        </dl>
        {run.error_message && (
          <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">
            <strong>{run.error_node ?? "error"}:</strong> {run.error_message}
          </p>
        )}
      </div>

      {/* Critical flags */}
      {result?.critical_safety_flags && result.critical_safety_flags.length > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-900/30">
          <div className="mb-1 flex items-center gap-1 text-sm font-medium text-red-800 dark:text-red-200">
            <AlertTriangle className="h-4 w-4" />
            Critical safety flags
          </div>
          <ul className="space-y-0.5 text-xs text-red-800 dark:text-red-200">
            {result.critical_safety_flags.map((flag, i) => (
              <li key={i}>
                <code className="rounded bg-red-100 px-1 dark:bg-red-900/60">{flag.code}</code>{" "}
                {flag.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Children tree */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Children ({detail.child_count})</h3>
        {children.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No children yet — parent may still be in precheck or children will appear as they spawn.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {children.map((child) => (
              <ChildRow key={child.id} child={child} />
            ))}
          </ul>
        )}
      </div>

      {/* Checkpoints timeline */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Checkpoints</h3>
        <ol className="space-y-0.5 text-xs">
          {run.checkpoints.map((cp, i) => (
            <li key={i} className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 hover:bg-muted">
              <span className="flex items-center gap-2">
                {STATUS_ICONS[cp.status === "halted" ? "completed" : cp.status] ?? null}
                <code className="font-mono">{cp.node}</code>
                {cp.reason && <span className="text-muted-foreground">{cp.reason}</span>}
                {cp.error && <span className="text-red-600 dark:text-red-400">{cp.error}</span>}
              </span>
              <span className="text-muted-foreground">{cp.duration_ms}ms</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ChildRow({ child }: { child: DischargeComposeChildRunRow }) {
  return (
    <li className="rounded-md border bg-background p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {STATUS_ICONS[child.status] ?? null}
          <code className="font-mono text-xs">{child.parent_node}</code>
          <span className="text-muted-foreground">→</span>
          <span className="font-medium">{child.module_key ?? child.workflow_key}</span>
        </div>
        <span className="text-xs text-muted-foreground">#{child.id}</span>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {formatDate(child.started_at)}
        {child.completed_at && ` · completed ${formatDate(child.completed_at)}`}
        {child.pause_reason && ` · paused: ${child.pause_reason}`}
      </div>
    </li>
  );
}

function SafetyBadge({ band }: { band: string }) {
  const cls = SAFETY_BAND_STYLES[band] ?? SAFETY_BAND_STYLES.ok;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {band}
    </span>
  );
}
