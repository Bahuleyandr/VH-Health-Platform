// src/middleware/roleMiddleware.js

/**
 * Role-Based Access Control Middleware
 * @param {...string} allowedRoles - List of allowed roles
 * @returns {Function} Express middleware function
 */
export default function roleMiddleware(...allowedRoles) {
  return (req, res, next) => {
    const user = req.user;

    if (!user || !user.role) {
      return res
        .status(403)
        .json({ success: false, message: 'Access denied. Role not found.' });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`,
      });
    }

    next();
  };
}
