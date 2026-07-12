// Shared types for the compliance dashboard god-split.

export interface BreachNotification {
  id?: number;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "reported" | "investigating" | "contained" | "resolved" | "closed";
  affected_individuals?: number;
  breach_date?: string;
  discovered_date?: string;
  reported_by?: string;
  phi_involved?: boolean;
  notification_sent?: boolean;
  resolution?: string;
  created_at?: string;
  updated_at?: string;
}

// Row shape of GET /compliance/audit/search — the explicit column list in
// apps/backend/src/routes/compliance/auditSearchRoutes.js (audit_log table).
export interface AuditSearchResult {
  id: number;
  user_id?: string | null;
  user_name?: string | null;
  user_role?: string | null;
  ip_address?: string | null;
  method?: string | null;
  path?: string | null;
  module?: string | null;
  action: string;
  resource?: string | null;
  resource_id?: string | null;
  metadata?: Record<string, unknown> | null;
  query_params?: Record<string, unknown> | null;
  request_summary?: string | null;
  status_code?: number | null;
  response_time_ms?: number | null;
  success?: boolean | null;
  user_agent?: string | null;
  created_at: string;
}

export interface ReportBreachPayload {
  title: string;
  description: string;
  severity: string;
  affected_individuals?: number;
  phi_involved?: boolean;
}

// Compliance dashboard endpoint shape — see complianceDashboardService.js.
export interface ComplianceDashboardResponse {
  data_processing_activities: {
    by_lawful_basis: Array<{ lawful_basis: string | null; count: number }>;
    dpia_pending: Array<{ id: number | string; activity_code: string; display_name: string }>;
    dpia_pending_count: number;
  };
  breach_incidents: {
    by_severity_status: Array<{ severity: string; status: string; count: number }>;
    regulator_notifications_pending: Array<{
      breach_id: number | string;
      severity: string;
      discovered_at: string;
      hours_since_discovery: number | string;
    }>;
    regulator_notifications_pending_count: number;
  };
  gdpr_erasure: { total: number; last_30d: number };
  legal_holds: { total: number; active: number };
  generated_at: string;
}

export interface CertificationCockpitResponse {
  cockpit_version: string;
  tenant_id: string;
  generated_at: string;
  declaration_boundary: {
    cert_ready_label: string;
    externally_certified_label: string;
    rule: string;
  };
  summary: {
    total_tracks: number;
    accepted_count: number;
    open_count: number;
    blocker_count: number;
    cert_ready_count: number;
    externally_certified_count: number;
  };
  tracks: CertificationTrack[];
}

export interface CertificationTrack {
  key: string;
  stage: string;
  control_code: string;
  control_area: string;
  control_name: string;
  status: string;
  acceptance_state: "accepted" | "open";
  cert_ready_declaration: string;
  external_certification_status: string;
  engagement_status: string;
  runbook_uri: string;
  evidence_uri: string | null;
  owner_uid: string | null;
  due_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  notes: string | null;
  updated_at: string | null;
  blockers: string[];
  blocker_count: number;
  supporting_controls: Array<{
    control_code: string;
    status: string;
    acceptance_state: "accepted" | "open";
    evidence_uri: string | null;
    verified_at: string | null;
  }>;
}
