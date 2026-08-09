import { fetchAdminAPI } from "./core";

export type ExternalRecoveryReason =
  | "initial_marker_reconciled"
  | "retained_range_verified"
  | "marker_absence_recorded";
export type ExternalRecoveryResumeReason =
  | "resume_cutoff_reconciled"
  | "source_count_reconciled"
  | "owner_recovery_evidence_reconciled";

export interface ExternalRecoveryActionReceipt {
  action_id: string;
  action: "register_offset" | "authorize_resume";
  command_class:
    | "register_paused_offset"
    | "register_marker_absent_offset"
    | "authorize_partition_resume";
  outcome: string;
  disposition?: "applied" | "exact_duplicate";
  offset_id?: string | null;
  effect_identity: string;
  command_fingerprint: string;
  audit_event_id?: string | null;
  recorded_at: string;
}

export interface ExternalRecoveryWorkbenchOffset {
  tenant_id: string;
  offset_id: string;
  facility_scope: "tenant" | "facility";
  facility_id: number | null;
  interface_family: string;
  direction: "inbound" | "outbound";
  source_partition: string;
  generation: number;
  high_water_position: string | null;
  high_water_token: string | null;
  retained_from_position: string | null;
  retained_from_token: string | null;
  resume_cutoff_position: string | null;
  resume_cutoff_token: string | null;
  recovery_state: string;
  reconciliation_reason: string | null;
  policy_version: string;
  retention_policy: string;
  retention_until: string;
  intake_retired_at: string | null;
  state_fingerprint: string;
  command_class: string;
  capabilities: { can_authorize_resume: boolean };
  refusal_reasons: string[];
  observations: {
    pending_rows: number;
    oldest_pending_age_seconds: number;
    dead_rows: number;
    unacknowledged_critical_reviews: number;
    oldest_unacknowledged_age_seconds: number;
  };
  latest_command_receipt: ExternalRecoveryActionReceipt | null;
}

export interface ExternalRecoveryWorkbench {
  offsets: ExternalRecoveryWorkbenchOffset[];
  count: number;
  capabilities: {
    can_register_exact_partition: boolean;
    supports_predicate_bulk_mutation: false;
  };
}

export interface ExternalRecoveryRegisterRequest {
  interface_family: string;
  subpath?: string | null;
  protocol?: string | null;
  stream_direction?: "inbound" | "outbound" | null;
  source_partition: string;
  generation: number;
  facility_id?: number | null;
  initial_position?: string | null;
  initial_token?: string | null;
  retained_from_position?: string | null;
  retained_from_token?: string | null;
  policy_version: string;
  policy_signature: string;
  retention_policy: string;
  retention_until: string;
  owner_evidence_reference: string;
  owner_evidence_signature: string;
  reason_code: ExternalRecoveryReason;
  reason_detail: string;
}

export interface ExternalRecoveryResumeRequest {
  expected_state_fingerprint: string;
  resume_cutoff_position: string;
  resume_cutoff_token: string;
  owner_evidence_reference: string;
  owner_evidence_signature: string;
  reason_code: ExternalRecoveryResumeReason;
  reason_detail: string;
}

function requireIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9_\-:.]{1,200}$/.test(key)) {
    throw new TypeError("A valid bounded Idempotency-Key is required");
  }
  return key;
}

export function loadExternalRecoveryWorkbench(
  filters: {
    interfaceFamily?: string;
    recoveryState?: string;
  } = {},
): Promise<ExternalRecoveryWorkbench> {
  const query = new URLSearchParams();
  if (filters.interfaceFamily?.trim()) {
    query.set("interface_family", filters.interfaceFamily.trim().toUpperCase());
  }
  if (filters.recoveryState?.trim()) {
    query.set("recovery_state", filters.recoveryState.trim().toLowerCase());
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return fetchAdminAPI<ExternalRecoveryWorkbench>(
    `/admin/continuity/external-recovery/workbench${suffix}`,
  );
}

export function registerExternalRecoveryOffset(
  idempotencyKey: string,
  request: ExternalRecoveryRegisterRequest,
): Promise<ExternalRecoveryActionReceipt> {
  return fetchAdminAPI<ExternalRecoveryActionReceipt>(
    "/admin/continuity/external-recovery/offsets",
    {
      method: "POST",
      headers: { "Idempotency-Key": requireIdempotencyKey(idempotencyKey) },
      body: request,
    },
  );
}

export function authorizeExternalRecoveryResume(
  offsetId: string,
  idempotencyKey: string,
  request: ExternalRecoveryResumeRequest,
): Promise<ExternalRecoveryActionReceipt> {
  return fetchAdminAPI<ExternalRecoveryActionReceipt>(
    `/admin/continuity/external-recovery/offsets/${encodeURIComponent(offsetId)}/resume-authorizations`,
    {
      method: "POST",
      headers: { "Idempotency-Key": requireIdempotencyKey(idempotencyKey) },
      body: request,
    },
  );
}
