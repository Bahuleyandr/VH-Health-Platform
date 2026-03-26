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
    params
  );
}

export function getTestCatalog(category?: string) {
  const params: QueryParams = {};
  if (category) params.category = category;
  return getJSON<TestCatalogItem[]>(API_ENDPOINTS.investigations.catalog, params);
}

export function upsertTestCatalog(data: Partial<TestCatalogItem>) {
  return postJSON<TestCatalogItem>(API_ENDPOINTS.investigations.catalog, data);
}

export function getSLADashboard(fromDate?: string, toDate?: string) {
  const params: QueryParams = {};
  if (fromDate) params.from_date = fromDate;
  if (toDate) params.to_date = toDate;
  return getJSON<SLADashboard>(API_ENDPOINTS.investigations.slaDashboard, params);
}

export function getPendingInvestigations() {
  return getJSON<Investigation[]>(API_ENDPOINTS.investigations.pending);
}

export function updateInvestigationStatus(id: number, status: string) {
  return putJSON<Investigation>(`/api/v1/investigations/${id}/status`, { status });
}

export function addInvestigationResults(id: number, results: Record<string, unknown>) {
  return putJSON<Investigation>(`/api/v1/investigations/${id}/results`, results);
}
