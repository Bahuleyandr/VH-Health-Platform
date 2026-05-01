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

export interface AuditSearchResult {
  id: number;
  action: string;
  user_id?: string;
  resource_type?: string;
  resource_id?: string;
  ip_address?: string;
  details?: string;
  timestamp: string;
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
