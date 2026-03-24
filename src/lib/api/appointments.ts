// src/lib/api/appointments.ts
import { getJSON, postJSON, fetchAdminAPI } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getAppointments<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.appointments.list, params);
}

export function getAppointmentAnalytics<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.analytics);
}

export function getAppointmentConflicts<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.conflicts);
}

export function getAppointmentCapacity<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.capacity);
}

export function getNoShows<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.noShows);
}

// --- New admin endpoints ---

export function bulkUpdateAppointmentStatus<T = unknown>(data: {
  appointment_ids: number[];
  status: "completed" | "cancelled" | "no_show";
  reason?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.appointments.admin.bulkUpdateStatus, data);
}

export function overrideBookAppointment<T = unknown>(data: {
  patient_id: number;
  doctor_id: number;
  appointment_date: string;
  reason?: string;
  override_reason?: string;
  ignore_conflicts?: boolean;
}) {
  return postJSON<T>(API_ENDPOINTS.appointments.admin.overrideBook, data);
}

export function resolveAppointmentConflict<T = unknown>(data: {
  conflict_appointments: [number, number];
  resolution_action: "cancel_first" | "cancel_second" | "reschedule_first" | "reschedule_second";
  new_time?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.appointments.admin.resolveConflict, data);
}

export function sendAppointmentReminders<T = unknown>(data?: {
  hours_before?: number;
  include_departments?: number[];
  exclude_cancelled?: boolean;
}) {
  return postJSON<T>(API_ENDPOINTS.appointments.admin.sendReminders, data);
}

export function bulkDeleteAppointments<T = unknown>(data: {
  appointment_ids: number[];
  reason: string;
}) {
  return fetchAdminAPI<T>(API_ENDPOINTS.appointments.admin.bulkDelete, {
    method: "DELETE",
    body: data,
  });
}

export function searchAppointments<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.search, params);
}

export function exportAppointments<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.export, params);
}
