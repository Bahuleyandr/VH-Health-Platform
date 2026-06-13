// src/hooks/index.ts
export * from "./api-hooks";
export * from "./useAuth";
export * from "./useDebounce";
export * from "./usePermissions";
export * from "./usePerformanceMonitor";
export * from "./useSelection";
export * from "./useSessionTimeout";
export * from "./useTheme";
export * from "./useWebSocket";
export * from "./useAdminStats";
export * from "./useUploads";
export * from "./useSOS";
export * from "./useAttendance";
export * from "./useSystemMonitoring";
// ADM-7: useAdminWebSocket is deprecated (no callers). Re-export removed so
// the barrel does not inadvertently surface it as a public API.
// export * from "./useAdminWebSocket";

// Intentionally NOT re-exporting from './use-dashboard' to avoid duplicate
// exports of `useDashboardData` (already re-exported via ./api-hooks).
// If you later add *distinct* named exports in './use-dashboard', re-export
// them explicitly here, e.g.:
// export { useSomeOtherDashboardHook } from './use-dashboard';
