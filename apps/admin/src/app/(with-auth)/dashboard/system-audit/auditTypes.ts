export interface AuditSummaryActivity {
  total_requests: string;
  failed_requests: string;
  write_actions: string;
  unique_users: string;
  avg_response_ms: string;
  max_response_ms: string;
}

export interface TopUser {
  user_name: string;
  user_role: string;
  action_count: string;
  writes: string;
  failures: string;
}

export interface TopModule {
  module: string;
  count: string;
  failures: string;
}

export interface AuditError {
  id: string;
  user_name: string | null;
  method: string;
  path: string;
  status_code: number;
  error_message: string | null;
  created_at: string;
  response_time_ms: number;
}

export interface SlowRequest {
  id: string;
  user_name: string | null;
  method: string;
  path: string;
  response_time_ms: number;
  created_at: string;
}

export interface AuditSummary {
  period_hours: number;
  activity: AuditSummaryActivity;
  top_users: TopUser[];
  top_modules: TopModule[];
  recent_errors: AuditError[];
  slow_requests: SlowRequest[];
}

export interface AuditLogRow {
  id: string;
  user_id: number | null;
  user_name: string | null;
  user_role: string | null;
  ip_address: string | null;
  method: string;
  path: string;
  module: string | null;
  action: string | null;
  status_code: number;
  response_time_ms: number;
  success: boolean;
  request_summary: string | null;
  error_message: string | null;
  created_at: string;
}

export interface LogsResponse {
  logs: AuditLogRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ModulesResponse {
  modules: string[];
  actions: string[];
}

export interface UserHistory {
  user_id: string;
  period_days: number;
  stats: {
    total: string;
    writes: string;
    failures: string;
    modules_accessed: string[] | null;
  };
  logs: AuditLogRow[];
}

// ── Unified clinical governance feed (GET /api/v1/admin/audit/unified) ──────
// Hand-authored from the controller's normalized UNION SELECT
// (getUnifiedAuditLogs in apps/backend/src/controllers/admin/
// auditQueryController.js) — the OpenAPI schema for this path is an untyped
// Success envelope, so there is no spec-derived type to import. Every column
// is cast to ::text in SQL, hence the string-or-null shapes below.

/** Which audit sink a unified row came from. */
export type UnifiedAuditSource = "request" | "clinical" | "patient_access";

export interface UnifiedAuditRow {
  source: UnifiedAuditSource;
  tenant_id: string | null;
  id: string;
  occurred_at: string;
  actor_uid: string | null;
  actor_role: string | null;
  patient_uid: string | null;
  action: string | null;
  action_status: string | null;
  resource_type: string | null;
  resource_table: string | null;
  resource_id: string | null;
  summary: string | null;
  /** Per-source detail payload (request: method/path/status; clinical:
   * before/after state; patient_access: decision context). */
  metadata: Record<string, unknown> | null;
}

/** The `data` payload of the unified endpoint (no total count is returned —
 * next-page availability is inferred from a full page of rows). */
export interface UnifiedAuditResponse {
  logs: UnifiedAuditRow[];
  limit: number;
  offset: number;
  filters: {
    source: string | null;
    action: string | null;
    actor_uid: string | null;
    patient_uid: string | null;
    status: string | null;
    from: string | null;
    to: string | null;
    search: string | null;
  };
}

// ── Accountability workspace (GET /api/v1/admin/audit/events) ───────────────

export type AuditWorkspaceView =
  | "all"
  | "staff"
  | "doctor"
  | "patient"
  | "time"
  | "health";

export interface AuditEvent {
  id: string;
  source: string;
  occurred_at: string;
  recorded_at: string | null;
  actor_uid: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  department_id: string | null;
  patient_uid: string | null;
  patient_id: string | null;
  patient_name: string | null;
  encounter_id: string | null;
  admission_id: string | null;
  action: string;
  outcome: string | null;
  category: string | null;
  resource_type: string | null;
  resource_id: string | null;
  request_id: string | null;
  device_type: string | null;
  ip_address: string | null;
  integrity_status: string | null;
  summary: string | null;
}

export interface AuditEventDetail extends AuditEvent {
  metadata: Record<string, unknown> | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  redactions: string[];
}

export interface AuditEventSummary {
  total?: number;
  success?: number;
  failure?: number;
  denied?: number;
  unique_staff?: number;
  unique_patients?: number;
  [key: string]: unknown;
}

export interface AuditEventsResponse {
  events: AuditEvent[];
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
    limit: number;
  };
  summary: AuditEventSummary | null;
}

export interface AuditWorkspaceFilters {
  actor_uid: string;
  actor_role: string;
  patient_uid: string;
  department_id: string;
  action: string;
  resource_type: string;
  outcome: string;
  encounter_id: string;
  admission_id: string;
  from: string;
  to: string;
  source: string;
}

export interface AuditHealthSource {
  source: string;
  status: string | null;
  event_count: number | null;
  last_event_at: string | null;
  missing_actor_count: number | null;
  missing_request_id_count: number | null;
}

export interface AuditIntegrityHealth {
  total_events: number;
  missing_hash_count: number;
  hash_mismatch_count: number;
  continuity_break_count: number;
  first_problem_seq: number | null;
  first_problem_id: string | null;
  first_missing_hash_id: string | null;
  intact: boolean;
}

export interface AuditResourceCompleteness {
  resource_table: string;
  resource_rows: number;
  audited_resource_rows: number;
  orphan_resource_rows: number;
  audit_event_count: number;
  dangling_audit_events: number;
  coverage_percent: number | null;
}

export interface HighPatientAccessActor {
  actor_uid: string;
  actor_role: string | null;
  distinct_patient_count: number;
  access_event_count: number;
}

export interface AuditAnomalies {
  denied_attempts: number;
  break_glass_accesses: number;
  after_hours_accesses: number;
  audit_exports: number;
  after_hours_timezone: string;
  after_hours_window: string;
  high_patient_access_threshold: number;
  high_patient_access_actors: number;
  high_patient_access_actor_details: HighPatientAccessActor[];
}

export interface AuditHealthResponse {
  generated_at: string | null;
  window: Record<string, unknown> | null;
  sources: AuditHealthSource[];
  completeness: Record<string, unknown> | null;
  canonical_write_coverage: Record<string, unknown> | number | null;
  total_events: number | null;
  integrity: AuditIntegrityHealth | null;
  resource_completeness: AuditResourceCompleteness[];
  anomalies: AuditAnomalies | null;
}

