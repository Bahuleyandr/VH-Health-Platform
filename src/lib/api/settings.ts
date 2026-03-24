// src/lib/api/settings.ts
import { putJSON, getJSON } from "./core";

export function updateSystemSetting<T = unknown>(key: string, value: unknown) {
  return putJSON<T>(`/api/v1/settings/${encodeURIComponent(key)}`, { value });
}

export function getSystemSettings<T = unknown>() {
  return getJSON<T>("/api/v1/settings");
}
