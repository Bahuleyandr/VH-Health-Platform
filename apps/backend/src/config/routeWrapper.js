// src/config/routeWrapper.js
import logger from '../logging/logger.js';
import { auditLogger } from '../middleware/auditLogger.js';
import { validateUID, validatePhone } from '../middleware/identityValidator.js';
import { dynamicRoleRateLimiter, getRateLimiter } from '../middleware/rateLimitMiddleware.js';
import rbac from '../middleware/rbacMiddleware.js';
import rbacConfig from './rbacConfig.js';
import { ROUTE_RATE_PROFILES, ROUTE_AUDIT_DISABLED } from './routeWrapperSettings.js';

/**
 * Wraps an async route handler so that thrown errors are caught and forwarded
 * to Express's error handler instead of crashing the process.
 *
 * Exported so route modules that hand-build router.METHOD(...) calls (rather
 * than going through wrapAutoRBAC / wrapRoutes) can use it directly. The
 * IPD support / paeds immunisation / bed inspection routes (architectural
 * items A4 / A10 / D1) all rely on this export.
 */
export function wrapAsync(fn) {
  if (typeof fn !== 'function') return fn;
  // Only wrap if the function looks async (has 2-3 params like a route handler)
  if (fn.length > 3) return fn; // error handler middleware, skip
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

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

  const auditSuppressed = skipAudit || (configKey && ROUTE_AUDIT_DISABLED[configKey]);

  // Process each HTTP method (get, post, etc.) in the route map
  for (const [methodKey, routes] of Object.entries(routeMap)) {
    const method = (methodKey || 'get').toLowerCase();
    
    if (typeof router[method] !== 'function') {
      logger.warn(`[routeWrapper] Invalid HTTP method: ${method}`);
      continue;
    }

    const isWrite = ['post', 'put', 'patch', 'delete'].includes(method);

    if (!Array.isArray(routes)) {
      logger.warn(`[routeWrapper] Routes for method ${method} is not an array:`, routes);
      continue;
    }

    routes.forEach((routeConfig) => {
      if (!Array.isArray(routeConfig) || routeConfig.length < 1) {
        logger.warn(`[routeWrapper] Invalid route config:`, routeConfig);
        return;
      }

      const [path, ...handlers] = routeConfig;
      
      // ✅ FIX: This flattens nested arrays of middleware and validators.
      // For example, an array like [ [validator1, validator2], handler ] becomes
      // [ validator1, validator2, handler ], which Express can process correctly.
      const flattenedHandlers = handlers.flat();
      
      if (typeof path !== 'string') {
        logger.warn(`[routeWrapper] Invalid path for ${method}:`, path);
        return;
      }

      const middlewareStack = [];

      if (!skipRBAC && allowedRoles.length > 0) {
        middlewareStack.push(rbac(allowedRoles));
      }

      if (!auditSuppressed) {
        middlewareStack.push(auditLogger);
      }

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
  const wrappedMiddleware = middlewareStack.map(m => wrapAsync(m));
  const wrappedHandlers = flattenedHandlers.map(h => wrapAsync(h));
  router[method](path, ...wrappedMiddleware, ...wrappedHandlers);
} catch (error) {
  logger.error(`❌ routeWrapper failed at: method=${method}, path="${path}"`);
  logger.error(`❌ Handler stack:`, flattenedHandlers.map(f => typeof f).join(', '));
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

function routeMapHasEntries(routeMap = {}) {
  return Object.values(routeMap || {}).some((routes) => Array.isArray(routes) && routes.length > 0);
}

/**
 * wrapAutoRBAC — loads roles from rbacConfig + allows centralized config
 */
export function wrapAutoRBAC(router, configKey, routeMap = {}, options = {}) {
  if (typeof configKey !== 'string' || configKey.trim().length === 0) {
    throw new Error('[routeWrapper] wrapAutoRBAC requires a non-empty configKey');
  }

  if (!Object.prototype.hasOwnProperty.call(rbacConfig, configKey)) {
    logger.error(`[routeWrapper] Missing RBAC config key: ${configKey}`);
    throw new Error(`[routeWrapper] Missing RBAC config key: ${configKey}`);
  }

  const roles = rbacConfig[configKey];
  if (!Array.isArray(roles)) {
    logger.error(`[routeWrapper] RBAC config key ${configKey} must be an array`);
    throw new Error(`[routeWrapper] RBAC config key ${configKey} must be an array`);
  }

  if (!options.skipRBAC && routeMapHasEntries(routeMap) && roles.length === 0) {
    logger.error(`[routeWrapper] RBAC config key ${configKey} has no roles for protected routes`);
    throw new Error(`[routeWrapper] RBAC config key ${configKey} has no roles for protected routes`);
  }

  return wrapRoutes(router, roles, routeMap, { ...options, configKey });
}
