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
  type?:
    | "APPOINTMENT"
    | "MEDICATION"
    | "EMERGENCY"
    | "SYSTEM"
    | "REMINDER"
    | "ALERT"
    | "INFO"
    | "ANNOUNCEMENT";
  priority?: "HIGH" | "MEDIUM" | "LOW";
  user_ids?: number[];
  criteria?: Record<string, unknown>;
  scheduled_for?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.targeted, data);
}

export function getNotificationStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.statsSummary);
}
