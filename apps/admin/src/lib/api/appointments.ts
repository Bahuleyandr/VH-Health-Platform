// src/lib/api/appointments.ts
import { getJSON, postJSON, fetchAdminAPI } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";
import type { ApiData } from "@/lib/openapi-data";

// ── Spec-derived response types (OpenAPI Phase 5 — appointments slice) ──────
// Derived from the canonical spec via `ApiData` (the unwrapped `.data` payload)
// so they track the backend contract and drift is caught at `tsc`. The admin
// analytics/conflicts/capacity/no-shows/search/export results have a typed
// envelope (LOOSE aggregate cells per the backend overlay, but the array +
// envelope structure is real). Mutator responses adopt their typed `data`.
export type AppointmentAnalytics = ApiData<
  "/api/v1/appointments/admin/analytics",
  "get"
>;
export type AppointmentConflicts = ApiData<
  "/api/v1/appointments/admin/conflicts",
  "get"
>;
export type AppointmentConflict = AppointmentConflicts["conflicts"][number];
export type CapacityAnalysis = ApiData<
  "/api/v1/appointments/admin/capacity",
  "get"
>;
export type NoShowReport = ApiData<
  "/api/v1/appointments/admin/no-shows",
  "get"
>;
export type NoShowPatient = NoShowReport["noShowPatients"][number];
export type AppointmentSearch = ApiData<
  "/api/v1/appointments/admin/search",
  "get"
>;
export type AppointmentExport = ApiData<
  "/api/v1/appointments/admin/export",
  "get"
>;
export type AppointmentExportRow = AppointmentExport["appointments"][number];

// Mutator response payloads (spec-derived).
export type BookAppointmentResult = ApiData<
  "/api/v1/appointments/book",
  "post"
>;
export type BulkUpdateStatusResult = ApiData<
  "/api/v1/appointments/admin/bulk-update-status",
  "post"
>;
export type OverrideBookResult = ApiData<
  "/api/v1/appointments/admin/override-book",
  "post"
>;
export type ResolveConflictResult = ApiData<
  "/api/v1/appointments/admin/resolve-conflict",
  "post"
>;
export type SendRemindersResult = ApiData<
  "/api/v1/appointments/admin/send-reminders",
  "post"
>;
export type BulkDeleteResult = ApiData<
  "/api/v1/appointments/admin/bulk-delete",
  "delete"
>;

export function getAppointments<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.appointments.list, params);
}

export function bookAppointmentAdmin(data: {
  patient_id?: number;
  patient_phone?: string;
  patient_name?: string;
  doctor_id: number;
  appointment_date: string;
  appointment_time: string;
  reason: string;
  notes?: string;
  visit_type?:
    "NEW" | "FOLLOW_UP" | "EMERGENCY" | "TELE" | "LAB_ONLY" | "PAEDIATRIC_OPD";
}) {
  return postJSON<BookAppointmentResult>(API_ENDPOINTS.appointments.book, data);
}

export function getAppointmentAnalytics() {
  return getJSON<AppointmentAnalytics>(
    API_ENDPOINTS.appointments.admin.analytics,
  );
}

export function getAppointmentConflicts() {
  return getJSON<AppointmentConflicts>(
    API_ENDPOINTS.appointments.admin.conflicts,
  );
}

export function getAppointmentCapacity() {
  return getJSON<CapacityAnalysis>(API_ENDPOINTS.appointments.admin.capacity);
}

export function getNoShows() {
  return getJSON<NoShowReport>(API_ENDPOINTS.appointments.admin.noShows);
}

// --- New admin endpoints ---

export function bulkUpdateAppointmentStatus(data: {
  appointment_ids: number[];
  status: "completed" | "cancelled" | "no_show";
  reason?: string;
}) {
  return postJSON<BulkUpdateStatusResult>(
    API_ENDPOINTS.appointments.admin.bulkUpdateStatus,
    data,
  );
}

export function overrideBookAppointment(data: {
  patient_id: number;
  doctor_id: number;
  appointment_date: string;
  reason?: string;
  override_reason?: string;
  ignore_conflicts?: boolean;
  visit_type?:
    "NEW" | "FOLLOW_UP" | "EMERGENCY" | "TELE" | "LAB_ONLY" | "PAEDIATRIC_OPD";
}) {
  return postJSON<OverrideBookResult>(
    API_ENDPOINTS.appointments.admin.overrideBook,
    data,
  );
}

export function resolveAppointmentConflict(data: {
  conflict_appointments: [number, number];
  resolution_action:
    "cancel_first" | "cancel_second" | "reschedule_first" | "reschedule_second";
  new_time?: string;
}) {
  return postJSON<ResolveConflictResult>(
    API_ENDPOINTS.appointments.admin.resolveConflict,
    data,
  );
}

export function sendAppointmentReminders(data?: {
  hours_before?: number;
  include_departments?: number[];
  exclude_cancelled?: boolean;
}) {
  return postJSON<SendRemindersResult>(
    API_ENDPOINTS.appointments.admin.sendReminders,
    data,
  );
}

export function bulkDeleteAppointments(data: {
  appointment_ids: number[];
  reason: string;
}) {
  return fetchAdminAPI<BulkDeleteResult>(
    API_ENDPOINTS.appointments.admin.bulkDelete,
    {
      method: "DELETE",
      body: data,
    },
  );
}

export function searchAppointments(params?: QueryParams) {
  return getJSON<AppointmentSearch>(
    API_ENDPOINTS.appointments.admin.search,
    params,
  );
}

export function exportAppointments(params?: QueryParams) {
  return getJSON<AppointmentExport>(
    API_ENDPOINTS.appointments.admin.export,
    params,
  );
}

// ── Workflow endpoints (confirmation, SLA, documents) ──────────────────────

// LOOSE backend schema — hand-typed for admin UI detail.
// The SLA dashboard `sla` block (slaRes[0]) is `additionalProperties:true` with
// no declared properties in the spec overlay (the analytics handler mixes
// `::int` counts with a `ROUND(...,1)::numeric` avg → Decimal-as-string), so
// `ApiData` would expose it as an open `{ [k]: unknown }` and lose the admin
// UI's typed field access. Counts are `::int` (number); avg_response_minutes is
// a Decimal serialized as string.
export interface SlaMetrics {
  total_with_sla: number;
  within_sla: number;
  breached_sla: number;
  avg_response_minutes: string | null;
}

// LOOSE backend schema — hand-typed for admin UI detail.
// `TodayQueueItem` / `PendingAppointment` (queue/today, pending) and the SLA
// dashboard `pending_confirmation` rows are all `additionalProperties:true` in
// the spec overlay. The admin queue/SLA UIs read fields the overlay does not
// enumerate (blood_group, reminder_24h_sent/_1h_sent, mins_waiting) plus the
// joined display columns, so this richer hand-authored shape is kept rather
// than collapsing to an open spec type. NOTE: `token_number` is `string | null`
// (DB `VARCHAR(20)` — appointments.token_number) per the spec; the previous
// `number | null` here was real drift, now reconciled to the contract.
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
  token_number: string | null;
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

// HYBRID (billing.ts pattern): the strict parts (`summary` `::int` counts,
// `by_status`, `date_range`) are pulled from the spec via indexed access on the
// `ApiData` base; the three LOOSE blocks (`sla`, `by_department`,
// `pending_confirmation` — all `additionalProperties:true` with no enumerated
// fields in the overlay) are replaced with the hand-typed shapes the admin UI
// relies on. `summary` is spec-derived: the backend `::int`-casts every count,
// so it is `number` (not the old `string`).
// NOTE: indexed access (`Base["summary"]`) rather than `Omit<Base, ...>` —
// `SlaDashboardResult` is `additionalProperties:true`, so the spec type carries
// a `& { [k: string]: unknown }` index signature; `Omit` over that collapses
// every kept key back to `unknown` (keyof includes `string`). Indexed access
// preserves the declared field types.
type SlaDashboardBase = ApiData<
  "/api/v1/appointments/admin/sla-dashboard",
  "get"
>;
export type SlaDashboardResponse = {
  summary: SlaDashboardBase["summary"];
  by_status: SlaDashboardBase["by_status"];
  date_range: SlaDashboardBase["date_range"];
  sla: SlaMetrics;
  by_department: {
    department: string;
    total: number;
    completed: number;
    confirmed: number;
    cancelled: number;
  }[];
  pending_confirmation: AppointmentWorkflow[];
};

export function getAppointmentSlaDashboard(params?: QueryParams) {
  return getJSON<SlaDashboardResponse>(
    API_ENDPOINTS.appointments.slaDashboard,
    params,
  );
}

export function confirmAppointmentAdmin<T = unknown>(
  id: number,
  data: {
    confirmation_notes?: string;
    appointment_date?: string;
    appointment_time?: string;
  },
) {
  return postJSON<T>(`/api/v1/appointments/${id}/confirm`, data);
}

export function markNoShowAdmin<T = unknown>(id: number) {
  return postJSON<T>(`/api/v1/appointments/${id}/no-show`, {});
}

export function completeAppointmentAdmin<T = unknown>(
  id: number,
  data?: { notes?: string },
) {
  return postJSON<T>(`/api/v1/appointments/${id}/complete`, data ?? {});
}

export function cancelAppointmentAdmin<T = unknown>(
  id: number,
  data?: { cancellation_reason?: string },
) {
  return postJSON<T>(`/api/v1/appointments/${id}/cancel`, data ?? {});
}

export function getAllAppointmentDocuments(params?: QueryParams) {
  return getJSON<AppointmentDocument[]>(
    API_ENDPOINTS.appointments.allDocuments,
    params,
  );
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
  return getJSON<SlotsResponse>(
    `/api/v1/appointments/slots?doctor_id=${doctor_id}&date=${date}`,
  );
}

export interface WalkInPayload {
  patient_name?: string;
  patient_phone?: string;
  patient_id?: number;
  patient_birthday?: string;
  patient_gender?: string;
  patient_address?: string;
  patient_weight_kg?: number;
  doctor_id?: number | string;
  department?: string;
  reason?: string;
  notes?: string;
  appointment_time?: string;
  visit_type?:
    "NEW" | "FOLLOW_UP" | "EMERGENCY" | "TELE" | "LAB_ONLY" | "PAEDIATRIC_OPD";
  // Guardian fields — required when DOB indicates the patient is a minor.
  // Closes findings 2026-05-08-pediatric-opd-receptionist-no-guardian-model,
  // 2026-05-10-pediatric-opd-receptionist-minor-guardian-id-not-structured,
  // 2026-05-11-pediatric-opd-receptionist-7501ae08,
  // 2026-05-09-pediatric-opd-patient-no-dependent-profile.
  guardian_name?: string;
  guardian_phone?: string;
  guardian_relationship?: string;
  guardian_id_type?: string;
  guardian_id_reference?: string;
  guardian_user_id?: number;
  // ANC fields — captured for OBGYN/ANC walk-ins. Backend writes the
  // pregnancy row alongside the appointment in one txn. Closes finding
  // 2026-05-08-obstetric-anc-receptionist-walkin-drops-anc-fields
  // and 2026-05-10-obstetric-anc-receptionist-walkin-ui-no-anc-fields.
  lmp_date?: string;
  edd_date?: string;
  gravida?: number;
  parity?: number;
  living_children?: number;
  abortions?: number;
  // Unidentified-ER mode. When `mode === 'unidentified'` and the
  // department routes to EMERGENCY, the backend mints a synthetic
  // UNIDENT-* placeholder phone so the registration can proceed
  // without a real number. Closes finding
  // 2026-05-09-emergency-walk-in-receptionist-no-phone-optional-er-path.
  mode?: "unidentified";
  unidentified?: boolean;
}

export function registerWalkInAdmin<T = unknown>(data: WalkInPayload) {
  return postJSON<T>("/api/v1/appointments/walk-in", data);
}

export function getTodayQueueAdmin<T = unknown>(params?: QueryParams) {
  return getJSON<T>("/api/v1/appointments/queue/today", params);
}
