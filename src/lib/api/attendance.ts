// src/lib/api/attendance.ts
import { getJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getAttendanceAnalytics<T = unknown>(params?: {
  department?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: 'day' | 'week' | 'month';
}) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.analytics, params);
}

export function getAttendanceAnomalies<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.anomalies);
}

export function getLateArrivals<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.lateArrivals, { 
    date, 
    department 
  });
}

export function getEarlyDepartures<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.earlyDepartures, { 
    date, 
    department 
  });
}

export function getAbsentReport<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.absentReport, { 
    date, 
    department 
  });
}
