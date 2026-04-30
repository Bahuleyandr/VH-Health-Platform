/**
 * Admin API client for the Phase A2 dedupe + merge workflow.
 *
 * Backed by /api/v1/admin/patient-identifiers and
 * /api/v1/admin/patient-merges. Listing + status decisions go through
 * the typed wrappers below; the page imports them directly.
 */

import { fetchAdminAPI, getJSON, postJSON } from './core';

// ---------------------------------------------------------------------------
// Identifier types (informational; we don't expose CRUD on this page yet)
// ---------------------------------------------------------------------------
export type PatientIdentifierType =
  | 'mrn' | 'uhid' | 'abha' | 'abha_address' | 'mobile' | 'aadhaar_token'
  | 'passport' | 'insurance' | 'tpa_card' | 'employee_id' | 'external_emr'
  | 'national_id' | 'driving_license' | 'other';

export type PatientIdentifierStatus = 'active' | 'retired' | 'merged_into';

export interface PatientIdentifier {
  id: number;
  tenant_id: string;
  patient_uid: string;
  identifier_type: PatientIdentifierType;
  identifier_value: string;
  identifier_value_hash: string | null;
  issuer: string | null;
  is_primary: boolean;
  status: PatientIdentifierStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Duplicate candidates
// ---------------------------------------------------------------------------
export type DuplicateCandidateStatus =
  | 'open' | 'merged' | 'rejected_not_duplicate' | 'expired';

export type DuplicateDetectedBy =
  | 'rule_engine' | 'admin_manual' | 'identifier_collision'
  | 'name_phonetic' | 'imported';

export interface DuplicateMatchSignal {
  identifier_type: PatientIdentifierType;
  identifier_value_match?: boolean;
  hit_count?: number;
}

export interface DuplicateCandidate {
  id: number;
  tenant_id: string;
  primary_uid: string;
  secondary_uid: string;
  confidence_score: number;
  match_signals: DuplicateMatchSignal[] | Record<string, unknown>;
  detected_by: DuplicateDetectedBy;
  detection_run_id: string | null;
  status: DuplicateCandidateStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DedupeRunSummary {
  run_id: string;
  scanned_pairs?: number;
  candidates_inserted?: number;
  candidates_skipped?: number;
  halted?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------
export type MergeRequestStatus =
  | 'requested' | 'approved' | 'executed' | 'rejected' | 'cancelled';

export interface MergeExecutionSummary {
  identifiers_reassigned: number;
  total_rows_moved: number;
  table_summary: Record<
    string,
    { rows_moved?: number; fk_column?: string; skipped?: string }
  >;
}

export interface PatientMergeRequest {
  id: number;
  tenant_id: string;
  candidate_id: number | null;
  primary_uid: string;
  secondary_uid: string;
  status: MergeRequestStatus;
  requested_by: string | null;
  requested_at: string;
  requester_note: string | null;
  approver_uid: string | null;
  approved_at: string | null;
  approver_note: string | null;
  executor_uid: string | null;
  executed_at: string | null;
  execution_summary: MergeExecutionSummary | null;
  rejection_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
export async function runDedupeDetect(payload: { limit?: number } = {}) {
  return postJSON<DedupeRunSummary>('/admin/patient-merges/detect', payload);
}

export async function listDuplicateCandidates(params: {
  status?: DuplicateCandidateStatus;
  detection_run_id?: string;
  min_confidence?: number;
  limit?: number;
} = {}) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.detection_run_id) query.detection_run_id = params.detection_run_id;
  if (params.min_confidence != null) query.min_confidence = params.min_confidence;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ candidates: DuplicateCandidate[]; count: number }>(
    '/admin/patient-merges/candidates',
    query,
  );
}

export async function rejectDuplicateCandidate(id: number, payload: { decision_note?: string | null } = {}) {
  return fetchAdminAPI<DuplicateCandidate>(`/admin/patient-merges/candidates/${id}/reject`, {
    method: 'PATCH',
    body: payload,
  });
}

// ---------------------------------------------------------------------------
// Merge workflow
// ---------------------------------------------------------------------------
export async function listMergeRequests(params: { status?: MergeRequestStatus; limit?: number } = {}) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ merge_requests: PatientMergeRequest[]; count: number }>(
    '/admin/patient-merges',
    query,
  );
}

export async function requestPatientMerge(payload: {
  primary_uid: string;
  secondary_uid: string;
  candidate_id?: number | null;
  requester_note?: string | null;
}) {
  return postJSON<PatientMergeRequest>('/admin/patient-merges', payload);
}

export async function approveMergeRequest(id: number, payload: { approver_note?: string | null } = {}) {
  return fetchAdminAPI<PatientMergeRequest>(`/admin/patient-merges/${id}/approve`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function rejectMergeRequest(id: number, payload: { rejection_reason?: string | null } = {}) {
  return fetchAdminAPI<PatientMergeRequest>(`/admin/patient-merges/${id}/reject`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function cancelMergeRequest(id: number, payload: { reason?: string | null } = {}) {
  return fetchAdminAPI<PatientMergeRequest>(`/admin/patient-merges/${id}/cancel`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function executeMergeRequest(id: number) {
  return postJSON<PatientMergeRequest>(`/admin/patient-merges/${id}/execute`, {});
}
