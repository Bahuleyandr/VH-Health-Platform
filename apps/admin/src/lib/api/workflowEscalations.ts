// src/lib/api/workflowEscalations.ts
// Typed client for the ADMIN workflow console (backend
// routes/admin/tasksWorkflowRoutes.js, mounted /api/v1/admin/workflow).
// The generated OpenAPI spec types these operations as the generic
// `Success` envelope only, so row shapes are hand-written here from the
// service RETURNING lists in services/workflow/taskService.js.

import { getJSON, putJSON } from "./core";

/* =========================
 * Enums (mirror taskService.js migration-118 enums)
 * ========================= */

export const ESCALATION_SCOPES = ["task", "workflow_step", "approval"] as const;
export const ESCALATION_TRIGGERS = [
  "sla_breach",
  "no_progress_after",
  "pending_too_long",
  "on_status_change",
] as const;
export const ESCALATION_ACTIONS = [
  "notify",
  "reassign",
  "escalate_priority",
  "auto_resolve",
  "webhook",
] as const;

// The sweep engine only evaluates/executes these subsets. The backend
// REFUSES to save an ACTIVE rule outside them (400 with codes
// ESCALATION_RULE_SCOPE_UNAVAILABLE / _TRIGGER_UNAVAILABLE /
// _ACTION_UNAVAILABLE); inactive drafts still save.
export const ENGINE_EVALUATED_SCOPES = ["task"] as const;
export const ENGINE_EVALUATED_TRIGGERS = [
  "sla_breach",
  "pending_too_long",
] as const;
export const ENGINE_EXECUTABLE_ACTIONS = [
  "notify",
  "reassign",
  "escalate_priority",
  "auto_resolve",
] as const;

export type EscalationScope = (typeof ESCALATION_SCOPES)[number];
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/* =========================
 * Row shapes
 * ========================= */

export interface EscalationRule {
  id: number;
  tenant_id: string;
  display_name: string;
  description: string | null;
  scope: EscalationScope;
  match_filter: Record<string, unknown> | null;
  trigger_condition: EscalationTrigger;
  trigger_window_minutes: number | null;
  action_kind: EscalationAction;
  action_payload: Record<string, unknown> | null;
  is_active: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

/** PUT /admin/workflow/escalation-rules upsert body — `id` present = update. */
export interface EscalationRulePayload {
  id?: number | null;
  display_name: string;
  description?: string | null;
  scope: EscalationScope;
  match_filter?: Record<string, unknown> | null;
  trigger_condition: EscalationTrigger;
  trigger_window_minutes?: number | null;
  action_kind: EscalationAction;
  action_payload?: Record<string, unknown> | null;
  is_active: boolean;
}

export interface SlaDefinition {
  id: number;
  tenant_id: string;
  sla_key: string;
  display_name: string | null;
  description: string | null;
  target_minutes: number;
  warn_at_pct: number;
  business_hours_only: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: number;
  tenant_id: string;
  workflow_definition_id: number;
  workflow_key: string;
  workflow_version: number;
  trigger_kind: string;
  status: string;
  current_step_key: string | null;
  started_at: string;
  ended_at: string | null;
  due_at: string | null;
  initiated_by: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowApproval {
  id: number;
  tenant_id: string;
  workflow_run_id: number | null;
  task_id: number | null;
  approval_kind: string;
  subject_resource_type: string | null;
  subject_resource_id: string | null;
  required_approvers: number | null;
  required_role: string | null;
  status: string;
  rejection_reason: string | null;
  expires_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
}

/* =========================
 * Calls
 * ========================= */

export async function listEscalationRules(
  params: { is_active?: boolean; scope?: EscalationScope } = {},
) {
  const query: Record<string, string> = {};
  if (params.is_active !== undefined)
    query.is_active = String(params.is_active);
  if (params.scope) query.scope = params.scope;
  return getJSON<{ rules: EscalationRule[]; count: number }>(
    "/admin/workflow/escalation-rules",
    query,
  );
}

export async function saveEscalationRule(payload: EscalationRulePayload) {
  return putJSON<EscalationRule>("/admin/workflow/escalation-rules", payload);
}

export async function listSlaDefinitions() {
  return getJSON<{ slas: SlaDefinition[]; count: number }>(
    "/admin/workflow/sla-definitions",
  );
}

export async function listWorkflowRuns(
  params: { status?: string; workflow_key?: string; limit?: number } = {},
) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.workflow_key) query.workflow_key = params.workflow_key;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ runs: WorkflowRun[]; count: number }>(
    "/admin/workflow/workflow-runs",
    query,
  );
}

export async function listApprovals(
  params: { status?: string; limit?: number } = {},
) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ approvals: WorkflowApproval[]; count: number }>(
    "/admin/workflow/approvals",
    query,
  );
}
