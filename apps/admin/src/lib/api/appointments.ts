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

// ── Workflow endpoints (confirmation, SLA, documents) ──────────────────────

export interface SlaSummary {
  total: string;
  confirmed: string;
  completed: string;
  cancelled: string;
  no_show: string;
  pending_confirmation: string;
}

export interface SlaMetrics {
  total_with_sla: string;
  within_sla: string;
  breached_sla: string;
  avg_response_minutes: string | null;
}

export interface AppointmentWorkflow {
  id: number;
  uid: string;
  patient_id: number;
  doctor_id: number;
  appointment_date: string;
  appointment_time: string;
  reason: string | null;
  notes: string | null;
  status: string;
  phone: string | null;
  token_number: number | null;
  confirmed_by: number | null;
  confirmed_at: string | null;
  confirmation_notes: string | null;
  no_show_at: string | null;
  cancellation_reason: string | null;
  completed_at: string | null;
  department: string | null;
  sla_target_at: string | null;
  first_contact_at: string | null;
  reschedule_count: number;
  // joined fields
  patient_name?: string;
  patient_phone?: string;
  doctor_name?: string;
  doctor_display_name?: string;
  mins_waiting?: number;
  sla_breached?: boolean;
}

export interface AppointmentDocument {
  id: number;
  appointment_id: number;
  patient_id: number | null;
  doctor_id: number | null;
  uploaded_by: number | null;
  upload_role: string;
  document_type: string;
  file_key: string;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  file_mime: string | null;
  notes: string | null;
  is_visible_to_patient: boolean;
  created_at: string;
  uploaded_by_name?: string;
  patient_name?: string;
  doctor_name?: string;
}

export interface AuditEntry {
  id: number;
  appointment_id: number;
  appointment_uid?: string;
  from_status: string | null;
  to_status: string;
  changed_by: number | null;
  changed_by_role: string | null;
  changed_by_name?: string | null;
  patient_name?: string | null;
  reason: string | null;
  created_at: string;
}

export interface SlaDashboardResponse {
  summary: SlaSummary;
  sla: SlaMetrics;
  by_status: { status: string; count: string }[];
  by_department: { department: string; total: string; completed: string; confirmed: string; cancelled: string }[];
  pending_confirmation: AppointmentWorkflow[];
  date_range: { from: string; to: string };
}

export function getAppointmentSlaDashboard(params?: QueryParams) {
  return getJSON<SlaDashboardResponse>(API_ENDPOINTS.appointments.slaDashboard, params);
}

export function getTodayQueue(params?: QueryParams) {
  return getJSON<AppointmentWorkflow[]>(API_ENDPOINTS.appointments.queue, params);
}

export function getPendingAppointments(params?: QueryParams) {
  return getJSON<AppointmentWorkflow[]>(API_ENDPOINTS.appointments.pending, params);
}

export function confirmAppointmentAdmin<T = unknown>(
  id: number,
  data: { confirmation_notes?: string; appointment_date?: string; appointment_time?: string }
) {
  return postJSON<T>(`/api/v1/appointments/${id}/confirm`, data);
}

export function markNoShowAdmin<T = unknown>(id: number) {
  return postJSON<T>(`/api/v1/appointments/${id}/no-show`, {});
}

export function completeAppointmentAdmin<T = unknown>(id: number, data?: { notes?: string }) {
  return postJSON<T>(`/api/v1/appointments/${id}/complete`, data ?? {});
}

export function cancelAppointmentAdmin<T = unknown>(id: number, data?: { cancellation_reason?: string }) {
  return postJSON<T>(`/api/v1/appointments/${id}/cancel`, data ?? {});
}

export function getAppointmentDocumentsAdmin(appointmentId: number) {
  return getJSON<AppointmentDocument[]>(`/api/v1/appointments/${appointmentId}/documents`);
}

export function getAllAppointmentDocuments(params?: QueryParams) {
  return getJSON<AppointmentDocument[]>(API_ENDPOINTS.appointments.allDocuments, params);
}

export function getAppointmentAuditTrail(params?: QueryParams) {
  return getJSON<AuditEntry[]>(API_ENDPOINTS.appointments.auditTrail, params);
}

// ── New: Slot availability & Walk-in ──────────────────────────────────────────

export interface SlotInfo {
  time: string;
  available: boolean;
}

export interface SlotsResponse {
  doctor_id: number;
  doctor_name: string;
  date: string;
  day: string;
  total_slots: number;
  available_slots: number;
  slots: SlotInfo[];
  available?: boolean;
  reason?: string;
}

export function getAvailableSlots(doctor_id: number | string, date: string) {
  return getJSON<SlotsResponse>(`/api/v1/appointments/slots?doctor_id=${doctor_id}&date=${date}`);
}

export interface WalkInPayload {
  patient_name?: string;
  patient_phone?: string;
  patient_id?: number;
  doctor_id?: number | string;
  department?: string;
  reason?: string;
  notes?: string;
  appointment_time?: string;
}

export function registerWalkInAdmin<T = unknown>(data: WalkInPayload) {
  return postJSON<T>("/api/v1/appointments/walk-in", data);
}

export function getTodayQueueAdmin<T = unknown>(params?: QueryParams) {
  return getJSON<T>("/api/v1/appointments/queue/today", params);
}
