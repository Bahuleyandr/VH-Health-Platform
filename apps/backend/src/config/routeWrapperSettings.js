// src/config/routeWrapperSettings.js

// ✅ Per-method override: routeKey.method → rateLimiter profile name
export const ROUTE_RATE_PROFILES = {
  'appointmentRoutes.post': 'strict',
  'feedbackRoutes.post': 'relaxed',
};

// ✅ Disable audit logging for lightweight GETs
export const ROUTE_AUDIT_DISABLED = {
  versionRoutes: true,
  debugRoutes: true
};
