import { getJSON, postJSON } from "./core";

// Incidents
export function getIncidents<T = unknown>(params?: { status?: string; severity?: string; incident_type?: string; limit?: number }) {
  return getJSON<T>('/api/v1/staff/admin/incidents', params);
}
export function getIncidentStats<T = unknown>() {
  return getJSON<T>('/api/v1/staff/admin/incidents/stats');
}
export function updateIncident<T = unknown>(id: string, data: Record<string, unknown>) {
  return postJSON<T>(`/api/v1/staff/admin/incidents/${id}/update`, data);
}

// Grievances
export function getGrievances<T = unknown>(params?: { status?: string; grievance_type?: string; limit?: number }) {
  return getJSON<T>('/api/v1/staff/admin/grievances', params);
}
export function getGrievanceStats<T = unknown>() {
  return getJSON<T>('/api/v1/staff/admin/grievances/stats');
}
export function updateGrievance<T = unknown>(id: string, data: Record<string, unknown>) {
  return postJSON<T>(`/api/v1/staff/admin/grievances/${id}/update`, data);
}

// Audit
export function getAuditDashboard<T = unknown>() {
  return getJSON<T>('/api/v1/staff/admin/audit/dashboard');
}
export function getAdminActivityReport<T = unknown>(days?: number) {
  return getJSON<T>('/api/v1/staff/admin/audit/activity', days ? { days } : undefined);
}
export function getSLAReport<T = unknown>(days?: number) {
  return getJSON<T>('/api/v1/staff/admin/audit/sla', days ? { days } : undefined);
}
export function getReportAuditTrail<T = unknown>(type: 'incident' | 'grievance', id: string) {
  return getJSON<T>(`/api/v1/staff/admin/audit/trail/${type}/${id}`);
}
