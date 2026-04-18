// src/lib/api/settings.ts
import { putJSON, getJSON } from "./core";

/**
 * GET /api/v1/system/settings
 * Returns all current system settings.
 */
export function getSystemSettings<T = unknown>() {
  return getJSON<T>("/api/v1/system/settings");
}

/**
 * PUT /api/v1/system/settings
 * Backend accepts a partial update object (key/value pairs).
 * Pass either a single key or a full settings object.
 *
 * Usage:
 *   updateSystemSetting("maintenanceMode", true)
 *   updateSystemSetting({ maintenanceMode: true, maxAppointmentsPerDay: 100 })
 */
export function updateSystemSetting<T = unknown>(
  keyOrObject: string | Record<string, unknown>,
  value?: unknown
) {
  const body: Record<string, unknown> =
    typeof keyOrObject === "string"
      ? { [keyOrObject]: value }
      : keyOrObject;

  return putJSON<T>("/api/v1/system/settings", body);
}
