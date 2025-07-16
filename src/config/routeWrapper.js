// src/config/routeWrapper.js
import { auditLogger } from '../middleware/auditLogger.js';
import { validateUID, validatePhone } from '../middleware/identityValidator.js';
import { dynamicRoleRateLimiter, getRateLimiter } from '../middleware/rateLimitMiddleware.js';
import rbac from '../middleware/rbacMiddleware.js';
import rbacConfig from './rbacConfig.js';
import { ROUTE_RATE_PROFILES, ROUTE_AUDIT_DISABLED } from './routeWrapperSettings.js';

/**
 * ✅ CORRECTED Base wrapper function to attach RBAC, rate limits, and other middleware.
 */
function applyWrappers(router, allowedRoles = [], routeMap = {}, options = {}) {
  const {
    requireUID = true,
    requirePhone = true,
    skipRBAC = false,
    skipAudit = false,
    configKey = null
  } = options;

  // Conditionally apply RBAC only if roles are specified and not skipped
  if (!skipRBAC && allowedRoles.length > 0) {
    router.use(rbac(allowedRoles));
  }

  // Conditionally apply audit logging
  const auditSuppressed = skipAudit || (configKey && ROUTE_AUDIT_DISABLED[configKey]);
  if (!auditSuppressed) {
    router.use(auditLogger);
  }

  // Process each HTTP method (get, post, etc.) in the route map
  for (const [methodKey, routes] of Object.entries(routeMap)) {
    const method = (methodKey || 'get').toLowerCase();
    
    if (typeof router[method] !== 'function') {
      console.warn(`[routeWrapper] Invalid HTTP method: ${method}`);
      continue;
    }

    const isWrite = ['post', 'put', 'patch', 'delete'].includes(method);

    if (!Array.isArray(routes)) {
      console.warn(`[routeWrapper] Routes for method ${method} is not an array:`, routes);
      continue;
    }

    routes.forEach((routeConfig) => {
      if (!Array.isArray(routeConfig) || routeConfig.length < 1) {
        console.warn(`[routeWrapper] Invalid route config:`, routeConfig);
        return;
      }

      const [path, ...handlers] = routeConfig;
      
      // ✅ FIX: This flattens nested arrays of middleware and validators.
      // For example, an array like [ [validator1, validator2], handler ] becomes
      // [ validator1, validator2, handler ], which Express can process correctly.
      const flattenedHandlers = handlers.flat();
      
      if (typeof path !== 'string') {
        console.warn(`[routeWrapper] Invalid path for ${method}:`, path);
        return;
      }

      const middlewareStack = [];

      // Apply rate limiter per routeKey
      const routeKey = `${configKey || 'generic'}.${method}`;
      const profile = ROUTE_RATE_PROFILES[routeKey];
      const limiter = profile ? getRateLimiter(profile) : (isWrite ? dynamicRoleRateLimiter : null);
      
      if (limiter) {
        middlewareStack.push(limiter);
      }

      // Add identity validators if required
      if (requireUID && validateUID) {
        middlewareStack.push(validateUID);
      }
      
      if (requirePhone && validatePhone) {
        middlewareStack.push(validatePhone);
      }

      try {
  router[method](path, ...middlewareStack, ...flattenedHandlers);
} catch (error) {
  console.error(`❌ routeWrapper failed at: method=${method}, path="${path}"`);
  console.error(`❌ Handler stack:`, flattenedHandlers.map(f => typeof f).join(', '));
  throw error; // re-throw to preserve original behavior
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