// src/lib/api/investigations.ts
import { getJSON, postJSON, putJSON } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";

/* ─── Types ─── */

export interface Investigation {
  id: number;
  patient_id: number;
  doctor_id: number;
  phone: string;
  test_name: string;
  test_code: string | null;
  type: string;
  priority: string;
  status: string;
  results: string | null;
  normal_range: string | null;
  unit: string | null;
  notes: string | null;
  cost: number | null;
  ordered_date: string;
  scheduled_date: string | null;
  completed_date: string | null;
  file_key: string | null;
  notified: boolean;
  notified_at: string | null;
  turnaround_target_hours: number | null;
  result_uploaded_at: string | null;
  urgent_alert_sent: boolean;
  patient_notified_at: string | null;
  // Joined fields
  patient_name?: string;
  patient_phone?: string;
  doctor_name?: string;
  hours_waiting?: number;
  tat_hours?: number;
}

export interface TestCatalogItem {
  id: number;
  name: string;
  code: string | null;
  category: string;
  description: string | null;
  normal_range: string | null;
  unit: string | null;
  default_cost: number | null;
  turnaround_hours: number;
  requires_fasting: boolean;
  patient_instructions: string | null;
  is_active: boolean;
  created_at: string;
}

export interface SLADashboard {
  summary: {
    total: string;
    completed: string;
    pending: string;
    urgent_pending: string;
    avg_tat_hours: string | null;
  };
  by_status: Array<{ status: string; count: string }>;
  by_priority: Array<{ priority: string; count: string }>;
  urgent_pending: Investigation[];
  recent_completed: Investigation[];
  date_range: { from: string; to: string };
}

/* ─── API Functions ─── */

export function getInvestigationsList(params?: QueryParams) {
  return getJSON<{ investigations: Investigation[]; pagination: unknown }>(
    API_ENDPOINTS.investigations.list,
    params,
  );
}

export function getTestCatalog(category?: string) {
  const params: QueryParams = {};
  if (category) params.category = category;
  return getJSON<TestCatalogItem[]>(
    API_ENDPOINTS.investigations.catalog,
    params,
  );
}

export function upsertTestCatalog(data: Partial<TestCatalogItem>) {
  return postJSON<TestCatalogItem>(API_ENDPOINTS.investigations.catalog, data);
}

export function getSLADashboard(fromDate?: string, toDate?: string) {
  const params: QueryParams = {};
  if (fromDate) params.from_date = fromDate;
  if (toDate) params.to_date = toDate;
  return getJSON<SLADashboard>(
    API_ENDPOINTS.investigations.slaDashboard,
    params,
  );
}

export function orderInvestigation(data: {
  patient_id: number;
  test_name: string;
  type: string;
  priority?: string;
  notes?: string;
}) {
  return postJSON<{ investigation: Investigation; patient_name?: string }>(
    "/api/v1/investigations/order",
    data,
  );
}

export function updateInvestigationStatus(id: number, status: string) {
  return putJSON<Investigation>(`/api/v1/investigations/${id}/status`, {
    status,
  });
}

/* ─── Investigation Bookings (Patient-Initiated) ─── */

export interface InvestigationBooking {
  id: number;
  booking_number: string;
  patient_id: number;
  patient_phone: string;
  patient_name: string;
  selected_tests: number[] | null;
  custom_test_names: string | null;
  slip_photo_url: string | null;
  slip_photo_key: string | null;
  collection_type: "home" | "walk_in";
  collection_address: string | null;
  collection_landmark: string | null;
  preferred_date: string | null;
  preferred_time_slot: string | null;
  estimated_cost: number | null;
  final_cost: number | null;
  status: string;
  confirmation_notes: string | null;
  actual_tests: string | null;
  confirmed_at: string | null;
  confirmed_by_name?: string;
  assigned_collector: number | null;
  collector_name?: string;
  collector_phone: string | null;
  dispatched_at: string | null;
  collected_at: string | null;
  collected_by: number | null;
  collection_notes: string | null;
  processing_started_at: string | null;
  result_uploaded_at: string | null;
  result_file_url: string | null;
  result_file_key: string | null;
  result_notes: string | null;
  notes: string | null;
  test_details?: Array<{
    id: number;
    name: string;
    default_cost: number;
    category: string;
  }>;
  test_names?: string[];
  mins_since_booked?: number;
  sla_breached?: boolean;
  sla_confirm_target: string | null;
  sla_dispatch_target: string | null;
  sla_collect_target: string | null;
  sla_result_target: string | null;
  estimated_collection_mins?: number | null;
  collection_distance_km?: number | null;
  collection_tracking_active?: boolean;
  created_at: string;
  updated_at: string;
}

export interface BookingSLADashboard {
  summary: {
    total: string;
    booked: string;
    confirmed: string;
    dispatched: string;
    collected: string;
    processing: string;
    result_ready: string;
    home_collection: string;
    walk_in: string;
    total_revenue: string;
  };
  by_status: Array<{ status: string; count: string }>;
  sla_breaches: number;
  avg_times: {
    avg_confirm_mins: string | null;
    avg_dispatch_mins: string | null;
    avg_collect_mins: string | null;
    avg_result_hours: string | null;
  };
  date_range: { from: string; to: string };
}

export function getBookingQueue(params?: QueryParams) {
  return getJSON<InvestigationBooking[]>(
    "/api/v1/investigations/bookings/queue",
    params,
  );
}

export function getBookingSLA(fromDate?: string, toDate?: string) {
  const params: QueryParams = {};
  if (fromDate) params.from_date = fromDate;
  if (toDate) params.to_date = toDate;
  return getJSON<BookingSLADashboard>(
    "/api/v1/investigations/bookings/sla",
    params,
  );
}

export function confirmBooking(
  id: number,
  data: {
    confirmation_notes?: string;
    actual_tests?: string;
    final_cost?: number;
  },
) {
  return postJSON<InvestigationBooking>(
    `/api/v1/investigations/bookings/${id}/confirm`,
    data,
  );
}

export function dispatchCollectorBooking(
  id: number,
  data: {
    assigned_collector?: number;
    collector_phone?: string;
    notes?: string;
  },
) {
  return postJSON<InvestigationBooking>(
    `/api/v1/investigations/bookings/${id}/dispatch`,
    data,
  );
}

export function markBookingCollected(
  id: number,
  data?: { collection_notes?: string },
) {
  return postJSON<InvestigationBooking>(
    `/api/v1/investigations/bookings/${id}/collected`,
    data ?? {},
  );
}

export function startBookingProcessing(id: number) {
  return postJSON<InvestigationBooking>(
    `/api/v1/investigations/bookings/${id}/processing`,
    {},
  );
}

export async function uploadBookingResult(
  id: number,
  file: File,
  notes?: string,
) {
  const { apiFetch } = await import("../api-fetch");
  const formData = new FormData();
  formData.append("file", file);
  if (notes) formData.append("result_notes", notes);

  const res = await apiFetch(`/api/v1/investigations/bookings/${id}/result`, {
    method: "POST",
    body: formData,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? "Upload failed");
  return json.data as InvestigationBooking;
}
