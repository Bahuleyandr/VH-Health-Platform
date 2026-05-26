/**
 * Admin client for the discharge_summary_compose meta-workflow.
 *
 * Wraps the four routes mounted under /api/v1/admin/clinical-ai by
 * apps/backend/src/routes/admin/clinicalAi/dischargeComposeRoutes.js:
 *
 *   POST /admin/clinical-ai/discharge-compose          start a fresh run
 *   GET  /admin/clinical-ai/discharge-compose          list recent runs
 *   GET  /admin/clinical-ai/discharge-compose/:runId   fetch run + children tree
 *   POST /admin/clinical-ai/discharge-compose/:runId/resume   resume a paused run
 *   POST /admin/clinical-ai/discharge-compose/:runId/fail     manually fail a paused run
 *
 * Same auth + envelope-unwrap behaviour as every other admin API
 * helper — fetchAdminAPI auto-prepends /api/v1, the proxy injects the
 * Authorization header server-side from the httpOnly auth_token cookie.
 */

import { fetchAdminAPI, getJSON } from "./core";

export type DischargeComposeStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type DischargeComposeChildKey =
  | "medication_reconciliation"
  | "patient_aftercare_instructions"
  | "discharge_readiness"
  | "clinical_coding_assist";

export interface DischargeComposeComponent {
  draft: Record<string, unknown> | null;
  review_id: number | null;
  generation_id: number | null;
  review_status: string | null;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
}

export interface DischargeComposeResult {
  module_key: "discharge_summary_compose";
  admission_id: number;
  compose_generation_id: number | null;
  overall_safety_band: "ok" | "low" | "medium" | "high" | "critical";
  compose_children: DischargeComposeChildKey[];
  components: Partial<
    Record<DischargeComposeChildKey, DischargeComposeComponent>
  >;
  child_generation_ids: number[];
  critical_safety_flags: Array<{
    severity: string;
    code: string;
    message: string;
  }>;
  requires_signoff: boolean;
}

export interface DischargeComposePauseResult {
  module_key: "discharge_summary_compose";
  admission_id: number;
  run_id: number;
  status: "paused";
  pause_reason: string;
  message: string;
}

export type DischargeComposePostResponse =
  | DischargeComposeResult
  | DischargeComposePauseResult;

export function isPaused(
  result: DischargeComposePostResponse,
): result is DischargeComposePauseResult {
  return (result as DischargeComposePauseResult).status === "paused";
}

export interface DischargeComposeRunRow {
  id: number;
  tenant_id: string;
  workflow_key: "discharge_summary_compose";
  module_key: string | null;
  patient_uid: string | null;
  admission_id: number | null;
  status: DischargeComposeStatus;
  current_node: string | null;
  pause_reason: string | null;
  state: Record<string, unknown>;
  result: DischargeComposeResult | null;
  error_node: string | null;
  error_message: string | null;
  checkpoints: Array<{
    node: string;
    started_at: string;
    completed_at?: string;
    paused_at?: string;
    duration_ms: number;
    status: "completed" | "paused" | "halted" | "failed";
    error?: string;
    reason?: string;
  }>;
  metadata: Record<string, unknown>;
  parent_run_id: number | null;
  parent_node: string | null;
  started_at: string;
  paused_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  updated_at: string;
}

export interface DischargeComposeChildRunRow {
  id: number;
  tenant_id: string;
  workflow_key: string;
  module_key: string | null;
  patient_uid: string | null;
  admission_id: number | null;
  status: DischargeComposeStatus;
  current_node: string | null;
  pause_reason: string | null;
  parent_run_id: number;
  parent_node: string | null;
  started_at: string;
  completed_at: string | null;
  failed_at: string | null;
  paused_at: string | null;
}

export interface DischargeComposeRunDetail {
  run: DischargeComposeRunRow;
  children: DischargeComposeChildRunRow[];
  child_count: number;
}

export interface DischargeComposeRunListItem {
  id: number;
  tenant_id: string;
  workflow_key: "discharge_summary_compose";
  module_key: string | null;
  patient_uid: string | null;
  admission_id: number | null;
  status: DischargeComposeStatus;
  current_node: string | null;
  pause_reason: string | null;
  started_at: string;
  paused_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  metadata: Record<string, unknown>;
}

export interface DischargeComposeRunListResponse {
  runs: DischargeComposeRunListItem[];
  count: number;
}

/** Start a fresh compose run for an admission. */
export async function startDischargeCompose(
  admissionId: number,
): Promise<DischargeComposePostResponse> {
  return fetchAdminAPI<DischargeComposePostResponse>(
    "/admin/clinical-ai/discharge-compose",
    {
      method: "POST",
      body: { admission_id: admissionId },
    },
  );
}

/** List recent top-level compose runs for the current tenant. */
export async function listDischargeCompose(
  params: {
    limit?: number;
    status?: DischargeComposeStatus;
  } = {},
): Promise<DischargeComposeRunListResponse> {
  const query: Record<string, string | number> = {};
  if (params.limit) query.limit = params.limit;
  if (params.status) query.status = params.status;
  return getJSON<DischargeComposeRunListResponse>(
    "/api/v1/admin/clinical-ai/discharge-compose",
    query,
  );
}

/** Fetch a compose run + its children tree. */
export async function getDischargeCompose(
  runId: number,
): Promise<DischargeComposeRunDetail> {
  return getJSON<DischargeComposeRunDetail>(
    `/api/v1/admin/clinical-ai/discharge-compose/${runId}`,
  );
}

export interface DischargeComposeResumeResponse {
  status: DischargeComposeStatus;
  runId: number;
  state: Record<string, unknown>;
  result?: DischargeComposeResult | null;
  pauseReason?: string;
  pausedAtNode?: string;
  error?: { node: string; message: string } | null;
}

/** Resume a paused compose run. */
export async function resumeDischargeCompose(
  runId: number,
): Promise<DischargeComposeResumeResponse> {
  return fetchAdminAPI<DischargeComposeResumeResponse>(
    `/admin/clinical-ai/discharge-compose/${runId}/resume`,
    { method: "POST" },
  );
}

export interface DischargeComposeFailResponse {
  status: "failed";
  runId: number;
  reason: string;
}

/** Manually fail a paused compose run whose external gate will never fire. */
export async function failDischargeCompose(
  runId: number,
  reason: string,
): Promise<DischargeComposeFailResponse> {
  return fetchAdminAPI<DischargeComposeFailResponse>(
    `/admin/clinical-ai/discharge-compose/${runId}/fail`,
    { method: "POST", body: { reason } },
  );
}
