// src/lib/api/reports.ts
import { getJSON, postJSON } from "./core";

export function getIncidents<T = unknown>(params?: {
  status?: string;
  severity?: string;
  incident_type?: string;
  limit?: number;
  offset?: number;
}) {
  return getJSON<T>("/api/v1/staff/admin/incidents", params as Record<string, string | number | boolean | undefined | null>);
}

export function getIncidentStats<T = unknown>() {
  return getJSON<T>("/api/v1/staff/admin/incidents/stats");
}

export function getAdminIncidentDetail<T = unknown>(id: string) {
  return getJSON<T>(`/api/v1/staff/admin/incidents/${id}`);
}

export function updateIncident<T = unknown>(id: string, data: Record<string, unknown>) {
  return postJSON<T>(`/api/v1/staff/admin/incidents/${id}/update`, data);
}

export function getGrievances<T = unknown>(params?: {
  status?: string;
  grievance_type?: string;
  limit?: number;
  offset?: number;
}) {
  return getJSON<T>("/api/v1/staff/admin/grievances", params as Record<string, string | number | boolean | undefined | null>);
}

export function getGrievanceStats<T = unknown>() {
  return getJSON<T>("/api/v1/staff/admin/grievances/stats");
}

export function getAdminGrievanceDetail<T = unknown>(id: string) {
  return getJSON<T>(`/api/v1/staff/admin/grievances/${id}`);
}

export function updateGrievance<T = unknown>(id: string, data: Record<string, unknown>) {
  return postJSON<T>(`/api/v1/staff/admin/grievances/${id}/update`, data);
}
