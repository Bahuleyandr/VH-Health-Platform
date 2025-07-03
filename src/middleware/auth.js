// src/middleware/auth.js - Authentication Middleware

import { verifyToken } from '../utils/jwtUtils.js';
import { error } from '../utils/responseHelper.js';
import { HTTP_STATUS } from '../config/responseCodes.js';
import logger from '../logging/logger.js';

// Authenticate JWT token
export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return error(res, 'Authorization token required', HTTP_STATUS.UNAUTHORIZED);
  }
  
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  
  if (!decoded) {
    return error(res, 'Invalid or expired token', HTTP_STATUS.UNAUTHORIZED);
  }
  
  // Attach user info to request
  req.user = decoded;
  next();
};

// Check if user is admin
export const requireAdmin = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return error(res, 'Admin access required', HTTP_STATUS.FORBIDDEN);
  }
  next();
};

// Check if user is staff
export const requireStaff = (req, res, next) => {
  if (!req.user || !req.user.isStaff) {
    return error(res, 'Staff access required', HTTP_STATUS.FORBIDDEN);
  }
  next();
};

// Check specific roles
export const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return error(res, 'Insufficient role privileges', HTTP_STATUS.FORBIDDEN);
    }
    next();
  };
};

// Check specific permissions
export const requirePermissions = (permissions) => {
  return (req, res, next) => {
    if (!req.user || !req.user.permissions) {
      return error(res, 'Insufficient permissions', HTTP_STATUS.FORBIDDEN);
    }
    
    const hasPermission = permissions.some(permission => 
      req.user.permissions.includes(permission)
    );
    
    if (!hasPermission) {
      return error(res, 'Insufficient permissions', HTTP_STATUS.FORBIDDEN);
    }
    
    next();
  };
};