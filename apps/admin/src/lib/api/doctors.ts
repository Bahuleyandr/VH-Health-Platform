// src/lib/api/doctors.ts
import { getJSON, postJSON, putJSON, deleteJSON } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getDoctors<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.doctors.list);
}

function hasDeleteAccountEndpoint(x: unknown): x is { deleteAccount: string } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Record<string, unknown>).deleteAccount === "string"
  );
}

export function deleteDoctor<T = unknown>(id: number) {
  if (!hasDeleteAccountEndpoint(API_ENDPOINTS.doctors)) {
    throw new Error(
      `deleteDoctor: API_ENDPOINTS.doctors.deleteAccount is not configured`
    );
  }
  const endpoint = API_ENDPOINTS.doctors.deleteAccount.replace(":id", String(id));
  return deleteJSON<T>(endpoint);
}

export function getDoctorProfile<T = unknown>(id: string) {
  return getJSON<T>(API_ENDPOINTS.doctors.profileById.replace(":id", id));
}

export function updateDoctorAvailability<T = unknown>(
  id: string,
  availability: boolean
) {
  return putJSON<T>(API_ENDPOINTS.doctors.availability.replace(":id", id), {
    is_available: availability
  });
}

// --- New admin endpoints ---

export function getDoctorOverview<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.doctors.admin.overview);
}

export function getDoctorManagementList<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.doctors.admin.manage, params);
}

export function getDoctorAnalytics<T = unknown>(id: string) {
  return getJSON<T>(API_ENDPOINTS.doctors.admin.analyticsById.replace(":id", id));
}

export function createDoctor<T = unknown>(data: {
  name: string;
  email?: string;
  phone: string;
  department_id: number;
  specialization?: string;
  qualification?: string;
  experience_years?: number;
}) {
  return postJSON<T>(API_ENDPOINTS.doctors.admin.create, data);
}

export function doctorBulkOperations<T = unknown>(data: {
  operation: string;
  doctor_ids: number[];
  [key: string]: unknown;
}) {
  return postJSON<T>(API_ENDPOINTS.doctors.admin.bulkOperations, data);
}

export function getDoctorWorkloadAnalysis<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.doctors.workloadAnalysis, params);
}
