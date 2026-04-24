// src/app/(with-auth)/dashboard/audit/components/types.ts
// Shared TypeScript types for the audit page tabs + panels.

export interface SLABreach {
  type: string;
  id: number;
  report_number: string;
  severity: string;
  title: string;
  status: string;
  created_at: string;
  assigned_to_name: string | null;
  hours_open: number;
  admin_action_count: number;
}

export interface RecentActivity {
  id: number;
  report_type: string;
  report_number: string;
  author_name: string;
  author_role: string;
  message: string;
  is_internal: boolean;
  created_at: string;
}

export interface Unassigned {
  type: string;
  id: number;
  report_number: string;
  priority_indicator: string;
  subject: string;
  created_at: string;
  hours_open?: number;
}

export interface AuditDashboardData {
  incidents: Record<string, string | number>;
  grievances: Record<string, string | number>;
  sla_breaches: SLABreach[];
  recent_activity: RecentActivity[];
  unassigned: Unassigned[];
}

export interface AdminActivityData {
  admin_activity: Array<{
    id: number;
    name: string;
    role: string;
    incident_actions: number;
    grievance_actions: number;
    total_actions: number;
    last_action: string;
    internal_notes: number;
    public_updates: number;
  }>;
  neglected_reports: Array<{
    type: string;
    report_number: string;
    subject: string;
    severity?: string;
    hours_open: number;
    assigned_to_name: string | null;
  }>;
  resolution_stats: Array<{
    type: string;
    resolved: number;
    open: number;
    total: number;
    resolution_rate_pct: number;
    avg_hours_to_resolve: number;
  }>;
}

export interface SLAData {
  incident_sla: Array<{
    severity: string;
    total: number;
    resolved: number;
    resolved_within_sla: number;
    currently_breached: number;
    avg_resolution_hours: number;
  }>;
  grievance_sla: Array<{
    priority: string;
    total: number;
    resolved: number;
    currently_breached: number;
    avg_resolution_hours: number;
  }>;
}

export type Tab = "overview" | "activity" | "sla";

export interface TrailTarget {
  type: "incident" | "grievance";
  id: string;
  number: string;
}
