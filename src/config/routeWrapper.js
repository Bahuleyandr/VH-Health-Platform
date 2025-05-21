// src/config/routeWrapper.js
import rbac from '../middleware/rbacMiddleware.js';
import { dynamicRoleRateLimiter, getRateLimiter } from '../middleware/rateLimitMiddleware.js';
import rbacConfig from './rbacConfig.js';
import { auditLogger } from '../middleware/auditLogger.js';
import { validateUID, validatePhone } from '../middleware/identityValidator.js';

/**
 * Optional fine-tuning per route profile
 * Format: { 'routeKey.method': 'rateProfileName' }
 */
import { ROUTE_RATE_PROFILES, ROUTE_AUDIT_DISABLED } from './routeWrapperSettings.js';

/**
 * Base wrapper function to attach RBAC, rate limits, audit logging, and identity validation.
 */
function applyWrappers(router, allowedRoles = [], routeMap = {}, options = {}) {
  const {
    requireUID = true,
    requirePhone = true,
    configKey = null
  } = options;

  if (allowedRoles.length > 0) {
    router.use(rbac(allowedRoles));
  }

  // Conditionally disable audit for some methods
  if (!ROUTE_AUDIT_DISABLED[configKey]) {
    router.use(auditLogger);
  }

  for (const [method, routes] of Object.entries(routeMap)) {
    const isWrite = ['post', 'put', 'patch', 'delete'].includes(method.toLowerCase());

    routes.forEach(([path, ...handlers]) => {
      const base = [];

      // Determine specific rate limiter
      const routeKey = `${configKey || 'generic'}.${method.toLowerCase()}`;
      const profile = ROUTE_RATE_PROFILES[routeKey];
      const limiter = profile ? getRateLimiter(profile) : (isWrite ? dynamicRoleRateLimiter : null);

      if (limiter) base.push(limiter);
      if (requireUID) base.push(validateUID);
      if (requirePhone) base.push(validatePhone);

      router[method](path, ...base, ...handlers);
    });
  }

  return router;
}

/**
 * wrapRoutes — for general use, no validation chaining
 */
export function wrapRoutes(router, allowedRoles = [], routeMap = {}, options = {}) {
  return applyWrappers(router, allowedRoles, routeMap, options);
}

/**
 * wrapRoutesWithValidation — assumes validator and handler
 */
export function wrapRoutesWithValidation(router, allowedRoles = [], routeMap = {}, options = {}) {
  const adjustedMap = {};
  for (const [method, routes] of Object.entries(routeMap)) {
    adjustedMap[method] = routes.map(([path, validator, handler]) => [path, validator, handler]);
  }
  return applyWrappers(router, allowedRoles, adjustedMap, options);
}

/**
 * wrapAutoRBAC — loads roles from rbacConfig + allows centralized config
 */
export function wrapAutoRBAC(router, configKey, routeMap = {}, options = {}) {
  const roles = rbacConfig[configKey] || [];
  return wrapRoutes(router, roles, routeMap, { ...options, configKey });
}
