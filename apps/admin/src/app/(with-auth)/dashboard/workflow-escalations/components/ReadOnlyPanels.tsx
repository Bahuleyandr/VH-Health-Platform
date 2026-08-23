"use client";

import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import type {
  SlaDefinition,
  WorkflowApproval,
  WorkflowRun,
} from "@/lib/api/workflowEscalations";
import { StatusPill, formatDateTime } from "./shared";

interface PanelState {
  isLoading: boolean;
  error: unknown;
}

function Panel({
  title,
  subtitle,
  state,
  isEmpty,
  emptyLabel,
  children,
}: {
  title: string;
  subtitle: string;
  state: PanelState;
  isEmpty: boolean;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {state.isLoading ? (
        <LoadingSpinner label={`Loading ${title.toLowerCase()}…`} />
      ) : state.error ? (
        <div className="p-4 text-sm text-red-700">
          {state.error instanceof Error ? state.error.message : "Failed to load"}
        </div>
      ) : isEmpty ? (
        <EmptyState
          compact
          icon={<Inbox className="h-8 w-8 text-muted-foreground" />}
          title={emptyLabel}
        />
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </div>
  );
}

const th = "px-3 py-2 text-left";
const td = "px-3 py-2 align-top";

export function SlaDefinitionsPanel({
  slas,
  state,
}: {
  slas: SlaDefinition[];
  state: PanelState;
}) {
  return (
    <Panel
      title="SLA Definitions"
      subtitle="Read-only — targets referenced by tasks and escalation triggers"
      state={state}
      isEmpty={slas.length === 0}
      emptyLabel="No SLA definitions"
    >
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className={th}>SLA key</th>
            <th className={th}>Name</th>
            <th className={th}>Target (min)</th>
            <th className={th}>Warn at</th>
            <th className={th}>Business hours</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {slas.map((sla) => (
            <tr key={sla.id}>
              <td className={`${td} font-mono text-xs`}>{sla.sla_key}</td>
              <td className={td}>{sla.display_name ?? "—"}</td>
              <td className={td}>{sla.target_minutes}</td>
              <td className={td}>{sla.warn_at_pct}%</td>
              <td className={td}>{sla.business_hours_only ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function WorkflowRunsPanel({
  runs,
  state,
}: {
  runs: WorkflowRun[];
  state: PanelState;
}) {
  return (
    <Panel
      title="Workflow Runs"
      subtitle="Read-only — most recent runs first"
      state={state}
      isEmpty={runs.length === 0}
      emptyLabel="No workflow runs"
    >
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className={th}>Workflow</th>
            <th className={th}>Status</th>
            <th className={th}>Current step</th>
            <th className={th}>Started</th>
            <th className={th}>Due</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((run) => (
            <tr key={run.id}>
              <td className={td}>
                <span className="font-medium text-foreground">{run.workflow_key}</span>
                <span className="ml-1 text-xs text-muted-foreground">v{run.workflow_version}</span>
                {run.failure_reason && (
                  <div className="mt-0.5 text-xs text-red-700">{run.failure_reason}</div>
                )}
              </td>
              <td className={td}><StatusPill value={run.status} /></td>
              <td className={`${td} font-mono text-xs`}>{run.current_step_key ?? "—"}</td>
              <td className={`${td} text-xs text-muted-foreground`}>{formatDateTime(run.started_at)}</td>
              <td className={`${td} text-xs text-muted-foreground`}>{formatDateTime(run.due_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function ApprovalsPanel({
  approvals,
  state,
}: {
  approvals: WorkflowApproval[];
  state: PanelState;
}) {
  return (
    <Panel
      title="Approvals"
      subtitle="Read-only — most recent first"
      state={state}
      isEmpty={approvals.length === 0}
      emptyLabel="No approvals"
    >
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className={th}>Kind</th>
            <th className={th}>Subject</th>
            <th className={th}>Required role</th>
            <th className={th}>Status</th>
            <th className={th}>Decided</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {approvals.map((approval) => (
            <tr key={approval.id}>
              <td className={td}>{approval.approval_kind}</td>
              <td className={`${td} text-xs text-muted-foreground`}>
                {approval.subject_resource_type
                  ? `${approval.subject_resource_type} #${approval.subject_resource_id ?? "?"}`
                  : "—"}
                {approval.rejection_reason && (
                  <div className="mt-0.5 text-red-700">{approval.rejection_reason}</div>
                )}
              </td>
              <td className={td}>{approval.required_role ?? "—"}</td>
              <td className={td}><StatusPill value={approval.status} /></td>
              <td className={`${td} text-xs text-muted-foreground`}>{formatDateTime(approval.decided_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
