// src/lib/api/doctors.ts
import { getJSON, putJSON, deleteJSON } from "./core";
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
  const endpoint = hasDeleteAccountEndpoint(API_ENDPOINTS.doctors)
    ? API_ENDPOINTS.doctors.deleteAccount.replace(":id", String(id))
    : `/doctors/${id}`; // fallback
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
