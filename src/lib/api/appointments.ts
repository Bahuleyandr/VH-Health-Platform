// src/lib/api/appointments.ts
import { getJSON } from "./core";
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
