// src/config/routeWrapper.js
import rbac from '../middleware/rbacMiddleware.js';
import { dynamicRoleRateLimiter, getRateLimiter } from '../middleware/rateLimitMiddleware.js';
import rbacConfig from './rbacConfig.js';
import { auditLogger } from '../middleware/auditLogger.js';
import { validateUID, validatePhone } from '../middleware/identityValidator.js';
import { ROUTE_RATE_PROFILES, ROUTE_AUDIT_DISABLED } from './routeWrapperSettings.js';

/**
 * Base wrapper function to attach RBAC, rate limits, audit logging, and identity validation.
 */
function applyWrappers(router, allowedRoles = [], routeMap = {}, options = {}) {
  const {
    requireUID = true,
    requirePhone = true,
    skipRBAC = false,
    skipAudit = false,
    configKey = null
  } = options;

  // ✅ Conditionally apply RBAC only if roles are specified and not skipped
  if (!skipRBAC && allowedRoles.length > 0) {
    router.use(rbac(allowedRoles));
  }

  // ✅ Conditionally apply audit
  const auditSuppressed = skipAudit || (configKey && ROUTE_AUDIT_DISABLED[configKey]);
  if (!auditSuppressed) {
    router.use(auditLogger);
  }

  // ✅ FIXED: Process each route method properly
  for (const [methodKey, routes] of Object.entries(routeMap)) {
    const method = (methodKey || 'get').toLowerCase();
    
    // ✅ Validate that the method exists on router
    if (typeof router[method] !== 'function') {
      console.warn(`[routeWrapper] Invalid HTTP method: ${method}`);
      continue;
    }

    const isWrite = ['post', 'put', 'patch', 'delete'].includes(method);

    // ✅ FIXED: Ensure routes is an array
    if (!Array.isArray(routes)) {
      console.warn(`[routeWrapper] Routes for method ${method} is not an array:`, routes);
      continue;
    }

    routes.forEach((routeConfig) => {
      // ✅ FIXED: Ensure routeConfig is an array with at least path
      if (!Array.isArray(routeConfig) || routeConfig.length < 1) {
        console.warn(`[routeWrapper] Invalid route config:`, routeConfig);
        return;
      }

      const [path, ...handlers] = routeConfig;
      
      // ✅ FIXED: Validate path is a string
      if (typeof path !== 'string') {
        console.warn(`[routeWrapper] Invalid path for ${method}:`, path);
        return;
      }

      // ✅ FIXED: Validate all handlers are functions
      const validHandlers = handlers.filter(handler => typeof handler === 'function');
      if (validHandlers.length !== handlers.length) {
        console.warn(`[routeWrapper] Some handlers are not functions for ${method} ${path}:`, handlers);
      }

      const middlewareStack = [];

      // ✅ Apply rate limiter per routeKey
      const routeKey = `${configKey || 'generic'}.${method}`;
      const profile = ROUTE_RATE_PROFILES[routeKey];
      const limiter = profile ? getRateLimiter(profile) : (isWrite ? dynamicRoleRateLimiter : null);
      
      if (limiter) {
        middlewareStack.push(limiter);
      }

      // ✅ FIXED: Only add identity validators if required AND they exist
      if (requireUID && validateUID) {
        middlewareStack.push(validateUID);
      }
      
      if (requirePhone && validatePhone) {
        middlewareStack.push(validatePhone);
      }

      // ✅ FIXED: Apply the route with proper error handling
      try {
        router[method](path, ...middlewareStack, ...validHandlers);
      } catch (error) {
        console.error(`[routeWrapper] Error registering route ${method} ${path}:`, error);
      }
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
  // ✅ FIXED: Don't modify the original routeMap, just pass it through
  // The structure should already be correct: [path, validator, handler]
  return applyWrappers(router, allowedRoles, routeMap, options);
}

/**
 * wrapAutoRBAC — loads roles from rbacConfig + allows centralized config
 */
export function wrapAutoRBAC(router, configKey, routeMap = {}, options = {}) {
  const roles = rbacConfig[configKey] || [];
  return wrapRoutes(router, roles, routeMap, { ...options, configKey });
}