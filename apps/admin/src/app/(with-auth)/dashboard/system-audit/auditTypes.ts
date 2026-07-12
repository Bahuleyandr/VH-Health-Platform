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

