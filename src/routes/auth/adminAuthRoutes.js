// src/routes/auth/adminAuthRoutes.js - Admin Authentication Routes
// Username/Password based authentication for admin web portal

import express from 'express';
import { validationResult, body } from 'express-validator';
import * as adminAuthController from '../../controllers/auth/adminAuthController.js';
import {
  usernamePasswordValidator,
  adminRegistrationValidator,
  passwordResetValidator,
  changePasswordValidator
} from '../../validators/auth/authValidator.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../../config/routeWrapper.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = express.Router();

// Validation middleware helper
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }
  next();
};

// Public Admin Authentication Routes
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Admin Login with Username/Password
      [
        '/login',
        ...usernamePasswordValidator,
        handleValidation,
        adminAuthController.login
      ],
      
      // Request Password Reset (sends OTP to registered email/phone)
      [
        '/forgot-password',
        body('username').notEmpty().withMessage('Username is required'),
        handleValidation,
        adminAuthController.forgotPassword
      ],
      
      // Reset Password with OTP
      [
        '/reset-password',
        ...passwordResetValidator,
        handleValidation,
        adminAuthController.resetPassword
      ]
    ],
    
    get: [
      // Admin Auth Health Check
      ['/health', adminAuthController.getHealthStatus]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false
  }
);

// Protected Admin Routes (requires authentication)
router.use(authenticateToken); // Apply auth middleware

wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Change Password (for logged-in admin)
      [
        '/change-password',
        ...changePasswordValidator,
        handleValidation,
        adminAuthController.changePassword
      ]
    ],
    
    get: [
      // Get Admin Profile
      ['/profile', adminAuthController.getProfile]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    skipAudit: false
  }
);

// Super Admin Routes (RBAC protected)
wrapAutoRBAC(
  router,
  'adminManagement',
  {
    post: [
      // Create New Admin User (Super Admin only)
      [
        '/create-admin',
        ...adminRegistrationValidator,
        handleValidation,
        adminAuthController.createAdmin
      ],
      
      // Deactivate Admin Account
      [
        '/deactivate',
        body('adminId').notEmpty().withMessage('Admin ID is required'),
        body('reason').notEmpty().withMessage('Reason is required'),
        handleValidation,
        adminAuthController.deactivateAdmin
      ],
      
      // Reactivate Admin Account
      [
        '/reactivate',
        body('adminId').notEmpty().withMessage('Admin ID is required'),
        handleValidation,
        adminAuthController.reactivateAdmin
      ]
    ],
    
    get: [
      // List All Admin Users
      ['/list', adminAuthController.listAdmins],
      
      // Get Admin Activity Logs
      ['/activity-logs/:adminId', adminAuthController.getAdminActivityLogs]
    ],
    
    put: [
      // Update Admin Permissions
      [
        '/update-permissions',
        body('adminId').notEmpty().withMessage('Admin ID is required'),
        body('permissions').isArray().withMessage('Permissions must be an array'),
        handleValidation,
        adminAuthController.updatePermissions
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true,
    roles: ['SUPER_ADMIN']
  }
);

export default router;