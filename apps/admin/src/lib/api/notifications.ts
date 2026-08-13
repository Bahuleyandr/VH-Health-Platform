// src/lib/api/notifications.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getNotificationTemplates<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.templates);
}

export function sendAnnouncement<T = unknown>(data: {
  title: string;
  message: string;
  priority?: "HIGH" | "MEDIUM" | "LOW";
  target_roles?: string[];
  target_departments?: string[];
  scheduled_for?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.announcement, data);
}

export function sendTargetedNotification<T = unknown>(data: {
  title: string;
  message: string;
  type?: "APPOINTMENT" | "MEDICATION" | "EMERGENCY" | "SYSTEM" | "REMINDER" | "ALERT" | "INFO" | "ANNOUNCEMENT";
  priority?: "HIGH" | "MEDIUM" | "LOW";
  user_ids?: number[];
  criteria?: Record<string, unknown>;
  scheduled_for?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.targeted, data);
}

export function sendBulkNotification<T = unknown>(data: {
  title: string;
  message: string;
  type?: string;
  target?: string;
  targetValue?: string;
  scheduledAt?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.bulk, data);
}

export function getNotificationStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.statsSummary);
}

export function getNotificationOverview<T = unknown>() {
  return getJSON<T>("/api/v1/notifications/admin/overview");
}

export function getNotificationManageList<T = unknown>(params?: { page?: number; limit?: number }) {
  return getJSON<T>("/api/v1/notifications/admin/manage", params);
}

export function getDeliveryStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.deliveryStats);
}

export function getScheduledPending<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.scheduledPending);
}

export function createNotification<T = unknown>(data: {
  title: string;
  message: string;
  type?: string;
  recipients?: string[];
  priority?: string;
  scheduledAt?: string;
}) {
  // Uses the legacy admin POST endpoint
  return postJSON<T>("/api/v1/notifications/admin", data);
}
