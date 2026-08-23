"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import { toast } from "react-hot-toast";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  listApprovals,
  listEscalationRules,
  listSlaDefinitions,
  listWorkflowRuns,
  saveEscalationRule,
  type EscalationRule,
  type EscalationRulePayload,
} from "@/lib/api/workflowEscalations";
import { EscalationRuleDialog } from "./components/EscalationRuleDialog";
import {
  ApprovalsPanel,
  SlaDefinitionsPanel,
  WorkflowRunsPanel,
} from "./components/ReadOnlyPanels";
import { StatusPill, formatDateTime, summarizeActionPayload } from "./components/shared";

export default function WorkflowEscalationsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<EscalationRule | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ["workflow-escalations", "rules"],
    queryFn: () => listEscalationRules(),
  });
  const slasQuery = useQuery({
    queryKey: ["workflow-escalations", "slas"],
    queryFn: () => listSlaDefinitions(),
  });
  const runsQuery = useQuery({
    queryKey: ["workflow-escalations", "runs"],
    queryFn: () => listWorkflowRuns({ limit: 50 }),
  });
  const approvalsQuery = useQuery({
    queryKey: ["workflow-escalations", "approvals"],
    queryFn: () => listApprovals({ limit: 50 }),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: EscalationRulePayload) => saveEscalationRule(payload),
    onSuccess: () => {
      toast.success("Escalation rule saved");
      setDialogOpen(false);
      setEditingRule(null);
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ["workflow-escalations", "rules"] });
    },
    onError: (err: Error) => {
      // Surface the backend's message verbatim inside the dialog.
      setSaveError(err.message || "Escalation rule save failed");
    },
  });

  const openCreate = () => {
    setEditingRule(null);
    setSaveError(null);
    setDialogOpen(true);
  };
  const openEdit = (rule: EscalationRule) => {
    setEditingRule(rule);
    setSaveError(null);
    setDialogOpen(true);
  };

  const rules = rulesQuery.data?.rules ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
            Workflow &amp; Escalations
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">
            Escalation Rules, SLAs, Runs, Approvals
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Escalation rule configuration plus read-only visibility into SLA
            definitions, workflow runs, and approvals.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["workflow-escalations"] })}
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New rule
          </button>
        </div>
      </div>

      <div
        role="alert"
        className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
      >
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <span className="font-semibold">Caution:</span> these rules page
          clinicians on breached critical-result SLAs. Editing, disabling, or
          retargeting a rule changes who gets paged for critical results — a
          wrong change can silence a critical-result page. Review every edit
          carefully before saving.
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <SlidersHorizontal className="h-4 w-4" />
              Escalation Rules
            </div>
            <div className="text-xs text-muted-foreground">
              {rulesQuery.data ? `${rulesQuery.data.count} rules` : ""}
            </div>
          </div>
        </div>

        {rulesQuery.isLoading ? (
          <LoadingSpinner label="Loading escalation rules…" />
        ) : rulesQuery.error ? (
          <div className="p-4 text-sm text-red-700">
            {rulesQuery.error instanceof Error
              ? rulesQuery.error.message
              : "Failed to load escalation rules"}
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            compact
            title="No escalation rules"
            description="Create a rule to page clinicians when SLAs breach."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Rule</th>
                  <th className="px-3 py-2 text-left">Scope</th>
                  <th className="px-3 py-2 text-left">Trigger</th>
                  <th className="px-3 py-2 text-left">Action · tiers / roles</th>
                  <th className="px-3 py-2 text-left">Enabled</th>
                  <th className="px-3 py-2 text-left">Updated</th>
                  <th className="px-3 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium text-foreground">{rule.display_name}</div>
                      {rule.description && (
                        <div className="mt-0.5 text-xs text-muted-foreground">{rule.description}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <StatusPill value={rule.scope} />
                    </td>
                    <td className="px-3 py-3 align-top text-xs">
                      <span className="font-mono">{rule.trigger_condition}</span>
                      {rule.trigger_window_minutes != null && (
                        <div className="text-muted-foreground">
                          window {rule.trigger_window_minutes} min
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-xs">
                      <span className="font-mono">{rule.action_kind}</span>
                      <div className="text-muted-foreground">
                        {summarizeActionPayload(rule.action_payload)}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <StatusPill value={rule.is_active ? "active" : "inactive"} />
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                      {formatDateTime(rule.updated_at)}
                    </td>
                    <td className="px-3 py-3 text-right align-top">
                      <button
                        type="button"
                        onClick={() => openEdit(rule)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SlaDefinitionsPanel
        slas={slasQuery.data?.slas ?? []}
        state={{ isLoading: slasQuery.isLoading, error: slasQuery.error }}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <WorkflowRunsPanel
          runs={runsQuery.data?.runs ?? []}
          state={{ isLoading: runsQuery.isLoading, error: runsQuery.error }}
        />
        <ApprovalsPanel
          approvals={approvalsQuery.data?.approvals ?? []}
          state={{ isLoading: approvalsQuery.isLoading, error: approvalsQuery.error }}
        />
      </div>

      <EscalationRuleDialog
        rule={editingRule}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditingRule(null);
        }}
        onSave={(payload) => saveMutation.mutate(payload)}
        saving={saveMutation.isPending}
        errorMessage={saveError}
      />
    </div>
  );
}
