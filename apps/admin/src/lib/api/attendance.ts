// src/lib/api/attendance.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getAttendanceAnalytics<T = unknown>(params?: {
  department?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: 'day' | 'week' | 'month';
}) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.analytics, params);
}

export function getAttendanceAnomalies<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.anomalies);
}

export function getLateArrivals<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.lateArrivals, { 
    date, 
    department 
  });
}

export function getEarlyDepartures<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.earlyDepartures, { 
    date, 
    department 
  });
}

export function getAbsentReport<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.absentReport, { 
    date, 
    department 
  });
}

// ─── Leave Approvals ───────────────────────────────────────────────────────

export function getLeaveApprovals<T = unknown>(params?: { 
  status?: string; 
  limit?: number;
  department?: string;
}) {
  return getJSON<T>('/api/v1/staff/admin/leave/pending', params);
}

export function approveLeave<T = unknown>(leaveId: string, comments?: string) {
  return postJSON<T>(`/api/v1/staff/admin/leave/${leaveId}/approve`, { comments });
}

export function rejectLeave<T = unknown>(leaveId: string, reason?: string) {
  return postJSON<T>(`/api/v1/staff/admin/leave/${leaveId}/reject`, { reason });
}

export function hrApproveReplacement<T = unknown>(requestId: string) {
  return postJSON<T>(`/api/v1/staff/admin/replacement/${requestId}/hr-approve`, {});
}

// ─── Disputes ──────────────────────────────────────────────────────────────

export function getPendingDisputes<T = unknown>() {
  return getJSON<T>('/api/v1/staff/admin/attendance/disputes/pending');
}

export function resolveDispute<T = unknown>(id: string | number, data: { 
  status: 'approved' | 'rejected'; 
  reviewer_comment?: string; 
  apply_correction?: boolean;
}) {
  return postJSON<T>(`/api/v1/staff/admin/attendance/disputes/${id}/resolve`, data);
}

// ─── Overtime ──────────────────────────────────────────────────────────────

export function getPendingOvertimeRequests<T = unknown>() {
  return getJSON<T>('/api/v1/staff/admin/overtime/pending');
}

export function approveOvertimeRequest<T = unknown>(id: string | number, data: {
  status: 'approved' | 'rejected';
  rejection_reason?: string;
}) {
  return postJSON<T>(`/api/v1/staff/admin/overtime/${id}/approve`, data);
}

// ─── Bulk Correction ───────────────────────────────────────────────────────

export function bulkCorrectAttendance<T = unknown>(data: {
  corrections: Array<{
    staff_id: string | number;
    date: string;
    check_in_time?: string;
    check_out_time?: string;
    reason?: string;
  }>;
  reason?: string;
}) {
  return postJSON<T>('/api/v1/staff/admin/bulk/attendance-correction', data);
}
