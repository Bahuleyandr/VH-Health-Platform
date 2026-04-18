// lib/config.ts - Configuration file
import { API_BASE_URL } from "./api-config";

export const config = {
  apiUrl: API_BASE_URL,
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Healthcare Admin",

  // API endpoints
  endpoints: {
    auth: {
      login: "/api/v1/auth/admin/login",
      profile: "/api/v1/auth/admin/profile",
      logout: "/api/v1/auth/admin/logout",
    },
    users: {
      dashboard: "/api/v1/users/dashboard",
      list: "/api/v1/users",
      detail: (id: string) => `/api/v1/users/${id}`,
    },
    doctors: {
      list: "/api/v1/doctors",
      detail: (id: string) => `/api/v1/doctors/${id}`,
    },
  },

  // Storage keys
  storage: {
    authToken: "authToken",
    userProfile: "userProfile",
  },

  // Request timeouts
  timeouts: {
    default: 30000, // 30 seconds
    upload: 120000, // 2 minutes
  },
};

/**
 * Centralized polling/refetch intervals for React Query and WebSocket hooks.
 * Use these instead of hardcoded numbers to keep intervals consistent and documented.
 */
export const POLLING_INTERVALS = {
  /** 5s — Emergency/SOS, critical real-time data */
  realtime: 5_000,
  /** 15s — Attendance, active monitoring dashboards */
  frequent: 15_000,
  /** 30s — General data refresh (appointments, users) */
  standard: 30_000,
  /** 60s — Analytics, reports, low-priority data */
  slow: 60_000,
} as const;

/**
 * Default pagination page size.
 */
export const DEFAULT_PAGE_SIZE = 10;
