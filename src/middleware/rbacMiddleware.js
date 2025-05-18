const { hasRole } = require('../utils/roles');

/**
 * RBAC Enforcement Middleware
 * @param {string[]} allowedRoles - List of allowed roles
 */
module.exports = (allowedRoles) => (req, res, next) => {
  if (!req.user || !hasRole(req.user, allowedRoles)) {
    return res.status(403).json({ error: 'Access denied: insufficient permissions' });
  }
  next();
};
