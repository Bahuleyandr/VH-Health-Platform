// src/middleware/rbacMiddleware.js
import { hasRole, normalizeRole, SUPER_ADMIN } from '../utils/roles.js';
import { logSecurityEvent } from '../utils/securityAuditLogger.js';

/**
 * RBAC Enforcement Middleware (factory)
 * Usage:
 *   app.use('/api/v1/admin', jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN'), router)
 *   app.use('/ops', jwtAuth, requireAnyRole('ADMIN', 'OPS'), router)
 *
 * @param {string[]|string} allowedRoles
 * @returns {import('express').RequestHandler}
 */
export default function rbacMiddleware(allowedRoles = []) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    try {
      // Not authenticated
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      // No restriction applied -> allow
      if (roles.length === 0) return next();

      const userRole = normalizeRole(req.user.role);

      // SUPER_ADMIN bypass (also handled by hasRole, but explicit here for clarity)
      if (userRole === SUPER_ADMIN) return next();

      // Check role membership (case-insensitive)
      if (!hasRole(userRole, roles)) {
        logSecurityEvent('PERMISSION_DENIED', {
          userId: req.user.uid || req.user.id,
          userName: req.user.email || req.user.phone,
          userRole,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
          path: req.originalUrl,
          method: req.method,
          reason: `Role '${userRole}' not in allowed roles: [${roles.join(', ')}]`,
        });
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Require one or more roles (variadic) */
export const requireRole = (...roles) => rbacMiddleware(roles);

/** Alias: require any of the provided roles */
export const requireAnyRole = (...roles) => rbacMiddleware(roles);
