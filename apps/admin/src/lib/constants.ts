// src/lib/constants.ts
// Centralised magic numbers and configuration values.

// ---- Timing (milliseconds) ----

/** Dashboard auto-refresh interval. */
export const DASHBOARD_REFRESH_INTERVAL_MS = 30_000; // 30 seconds

/** Live "seconds ago" ticker interval. */
export const SECONDS_AGO_TICK_MS = 1_000; // 1 second

// ---- Dashboard thresholds ----

/** "Updated X ago" badge turns yellow after this many seconds. */
export const UPDATED_BADGE_WARN_SECONDS = 35;

/** "Updated X ago" badge turns red after this many seconds. */
export const UPDATED_BADGE_CRITICAL_SECONDS = 60;

/** Show "just now" when updated fewer than this many seconds ago. */
export const UPDATED_BADGE_JUST_NOW_SECONDS = 5;

/** Doctors count below which a "warning" status is shown. */
export const DOCTORS_WARNING_THRESHOLD = 3;

/** Staff count below which a "warning" status is shown. */
export const STAFF_WARNING_THRESHOLD = 5;

// ---- Health gauge thresholds [warn, critical] ----

export const UPTIME_THRESHOLDS: [number, number] = [1, 5]; // inverted: 100-uptime
export const RESPONSE_TIME_THRESHOLDS: [number, number] = [100, 300]; // ms
export const ERROR_RATE_THRESHOLDS: [number, number] = [1, 5]; // %

// ---- Activity feed ----

/** Max items shown in the recent-activity feed. */
export const ACTIVITY_FEED_LIMIT = 10;
