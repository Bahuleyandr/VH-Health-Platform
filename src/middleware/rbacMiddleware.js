// src/middleware/rbacMiddleware.js

import { hasRole } from '../utils/roles.js';

/**
 * RBAC Enforcement Middleware
 * @param {string[]} allowedRoles - List of allowed roles
 */
export default function rbacMiddleware(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      console.warn('❌ RBAC Denied: Missing user information in request');
      return res
        .status(403)
        .json({ error: 'Access denied: no user information' });
    }

    const userRole = req.user.role;

    if (!hasRole(req.user, allowedRoles)) {
      console.warn(
        `❌ RBAC Denied: User role '${userRole}' not in allowed roles: [${allowedRoles.join(', ')}]`,
      );
      return res
        .status(403)
        .json({ error: 'Access denied: insufficient permissions' });
    }

    console.log(`✅ RBAC Granted: User role '${userRole}' is authorized`);
    next();
  };
}
