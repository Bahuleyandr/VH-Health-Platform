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

