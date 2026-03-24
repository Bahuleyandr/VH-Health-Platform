// src/lib/api/notifications.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getNotificationTemplates<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.templates);
}

export function sendAnnouncement<T = unknown>(data: {
  title: string;
  message: string;
  priority?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.announcement, data);
}

export function sendTargetedNotification<T = unknown>(data: {
  recipients: string[];
  title: string;
  message: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.targeted, data);
}

export function getNotificationStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.statsSummary);
}
