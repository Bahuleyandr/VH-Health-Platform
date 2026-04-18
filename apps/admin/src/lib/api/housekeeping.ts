import { getJSON, postJSON, putJSON } from "./core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HousekeepingZone {
  id: number;
  name: string;
  floor: string | null;
  building: string | null;
  zone_type: string;
  is_active: boolean;
  created_at: string;
}

export interface HousekeepingLog {
  id: number;
  log_number: string;
  staff_id: number;
  staff_name?: string;
  department?: string;
  zone_id: number | null;
  zone_name?: string;
  zone_type?: string;
  location_text: string | null;
  cleaning_type: string;
  notes: string | null;
  photo_key: string | null;
  photo_url: string | null;
  status: "submitted" | "verified" | "flagged";
  verified_by: number | null;
  verified_by_name?: string;
  verified_at: string | null;
  flag_reason: string | null;
  logged_at: string;
  created_at: string;
}

export interface HousekeepingRequest {
  id: number;
  request_number: string;
  requester_id: number;
  requester_name?: string;
  requester_dept?: string;
  zone_id: number | null;
  zone_name?: string;
  location_text: string;
  request_type: string;
  urgency: "low" | "normal" | "high" | "urgent";
  description: string | null;
  photo_key: string | null;
  photo_url: string | null;
  status: string;
  assigned_to: number | null;
  assigned_to_name?: string;
  assigned_at: string | null;
  completed_at: string | null;
  completion_notes: string | null;
  completion_photo_url: string | null;
  verified_at: string | null;
  sla_due_at: string | null;
  sla_breached: boolean;
  created_at: string;
  updated_at: string;
}

export interface HousekeepingStats {
  logs: {
    today: string;
    this_week: string;
    flagged: string;
    verified: string;
    total: string;
  };
  requests: {
    open: string;
    assigned: string;
    in_progress: string;
    completed: string;
    urgent_open: string;
    sla_breached: string;
    total: string;
  };
  sla: {
    completed_within_sla: string;
    completed_over_sla: string;
    currently_breached: string;
    avg_completion_minutes: string | null;
  };
  top_staff: Array<{ id: number; name: string; completions: string; avg_minutes: string | null }>;
  recent_flags: HousekeepingLog[];
}

// ─── Zones ───────────────────────────────────────────────────────────────────

export function getHousekeepingZones<T = HousekeepingZone[]>() {
  return getJSON<T>("/api/v1/staff/admin/housekeeping/zones");
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export function getHousekeepingLogs<T = { logs: HousekeepingLog[]; total: number }>(params?: {
  staff_id?: string;
  zone_id?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}) {
  return getJSON<T>("/api/v1/staff/admin/housekeeping/logs", params as Record<string, string | number | boolean | undefined | null>);
}

export function verifyLog<T = unknown>(id: number, data: { flag_reason?: string }) {
  return postJSON<T>(`/api/v1/staff/admin/housekeeping/logs/${id}/verify`, data);
}

// ─── Requests ────────────────────────────────────────────────────────────────

export function getHousekeepingRequests<T = { requests: HousekeepingRequest[]; total: number }>(params?: {
  status?: string;
  urgency?: string;
  assigned_to?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}) {
  return getJSON<T>("/api/v1/staff/admin/housekeeping/requests", params as Record<string, string | number | boolean | undefined | null>);
}

export function assignHousekeepingRequest<T = unknown>(
  id: number,
  data: { assigned_to: number; note?: string }
) {
  return postJSON<T>(`/api/v1/staff/admin/housekeeping/requests/${id}/assign`, data);
}

export function verifyHousekeepingRequest<T = unknown>(id: number) {
  return postJSON<T>(`/api/v1/staff/admin/housekeeping/requests/${id}/verify`, {});
}

// ─── Zone CRUD ───────────────────────────────────────────────────────────────

export function createHousekeepingZone<T = HousekeepingZone>(data: {
  name: string;
  zone_type?: string;
  floor?: string;
  building?: string;
}) {
  return postJSON<T>("/api/v1/staff/admin/housekeeping/zones", data);
}

export function updateHousekeepingZone<T = HousekeepingZone>(
  id: number,
  data: { name?: string; zone_type?: string; floor?: string; building?: string; is_active?: boolean }
) {
  return putJSON<T>(`/api/v1/staff/admin/housekeeping/zones/${id}`, data);
}

export function adminCreateHousekeepingRequest<T = HousekeepingRequest>(data: {
  zone_id?: number;
  location_text?: string;
  request_type?: string;
  urgency?: string;
  description?: string;
  assigned_to?: number;
}) {
  return postJSON<T>("/api/v1/staff/admin/housekeeping/requests/create", data);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export function getHousekeepingStats<T = HousekeepingStats>() {
  return getJSON<T>("/api/v1/staff/admin/housekeeping/stats");
}
