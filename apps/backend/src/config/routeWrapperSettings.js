// src/config/routeWrapperSettings.js

// Per-method override: routeKey.method → rateLimiter profile name.
//
// Every profile named here MUST exist in RATE_LIMIT_PROFILES
// (config/rateLimitProfiles.js) — getRateLimiter silently falls back to the
// generic `default` profile for unknown names, which is how the former
// 'appointmentRoutes.post': 'strict' / 'feedbackRoutes.post': 'relaxed'
// mappings spent their life pointing appointment/feedback writes at the
// generic bucket instead of the role-aware dynamicRoleRateLimiter every other
// wrapped write gets (finding 2026-08-14, backend-HTTP P3 #1). Those phantom
// mappings are gone; src/tests/unit/routeWrapperSettings.test.js now fails the
// build if a name lands here without a matching profile.
export const ROUTE_RATE_PROFILES = {};

// ✅ Disable audit logging for lightweight GETs
export const ROUTE_AUDIT_DISABLED = {
  versionRoutes: true,
  debugRoutes: true
};
