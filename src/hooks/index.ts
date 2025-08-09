// src/hooks/index.ts
export * from './api-hooks';
export * from './useAuth';
export * from './useDebounce';
export * from './usePermissions';
export * from './usePerformanceMonitor';
export * from './useSelection';
export * from './useSessionTimeout';
export * from './useTheme';
export * from './useWebSocket';

// Intentionally NOT re-exporting from './use-dashboard' to avoid duplicate
// exports of `useDashboardData` (already re-exported via ./api-hooks).
// If you later add *distinct* named exports in './use-dashboard', re-export
// them explicitly here, e.g.:
// export { useSomeOtherDashboardHook } from './use-dashboard';
