// src/routes/auth/adminAuthRoutes.js
// Admin Authentication Routes (username/email + password)

import express from 'express';
import { validationResult, body, oneOf, param } from 'express-validator';

import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as adminAuthController from '../../controllers/auth/adminAuthController.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import { otpRateLimiter, authRateLimiter } from '../../middleware/rateLimitMiddleware.js';

// Use the dedicated admin validators
import {
  adminLoginValidator,
  createAdminValidator,
  changeAdminPasswordValidator,
} from '../../validators/auth/adminAuthValidator.js';
import { passwordComplexityMiddleware } from '../../validators/passwordValidator.js';

const router = express.Router();

/* ----------------------------- helpers ----------------------------- */
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
    });
  }
  next();
};

// Inline validators for forgot/reset flows
const forgotPasswordValidator = [
  oneOf(
    [
      body('username').exists({ checkFalsy: true }).trim(),
      body('email').exists({ checkFalsy: true }).isEmail().normalizeEmail(),
    ],
    'Provide username or email'
  ),
];

const resetPasswordValidator = [
  oneOf(
    [
      body('username').optional({ nullable: true }).trim(),
      body('email').optional({ nullable: true }).isEmail().normalizeEmail(),
    ],
    'Provide username or email'
  ),
  body('otp').exists({ checkFalsy: true }).isLength({ min: 4, max: 8 }).withMessage('OTP is required'),
  body('newPassword')
    .exists({ checkFalsy: true }).withMessage('New password is required')
    .isLength({ min: 6 }).withMessage('New password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must contain uppercase, lowercase, number and special character'),
];

/* ------------------------- public auth routes ---------------------- */
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Login (username OR email + password) — rate limited: 5 attempts/15min per IP
      ['/login', authRateLimiter, ...adminLoginValidator, handleValidation, adminAuthController.login],

      // Request password reset (send OTP)
      ['/forgot-password', otpRateLimiter, ...forgotPasswordValidator, handleValidation, adminAuthController.forgotPassword],

      // Reset password with OTP
      ['/reset-password', ...resetPasswordValidator, handleValidation, adminAuthController.resetPassword],
    ],
    get: [['/health', adminAuthController.getHealthStatus]],
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false,
  }
);

/* ------------------------ protected auth routes -------------------- */
router.use(jwtAuth);

wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Change password (self)
      ['/change-password', ...changeAdminPasswordValidator, handleValidation, passwordComplexityMiddleware, adminAuthController.changePassword],
    ],
    get: [
      // Current admin profile
      ['/profile', adminAuthController.getProfile],
    ],
  },
  {
    requireUID: true,
    requirePhone: false,
    skipAudit: false,
  }
);

/* -------------------------- super-admin only ----------------------- */
wrapAutoRBAC(
  router,
  'adminManagement',
  {
    post: [
      // Create another admin
      ['/create-admin', ...createAdminValidator, handleValidation, passwordComplexityMiddleware, adminAuthController.createAdmin],

      // Deactivate admin
      [
        '/deactivate',
        body('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        body('reason').notEmpty().withMessage('Reason is required'),
        handleValidation,
        adminAuthController.deactivateAdmin,
      ],

      // Reactivate admin
      [
        '/reactivate',
        body('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        handleValidation,
        adminAuthController.reactivateAdmin,
      ],

      // Revoke all sessions for a user (force-logout compromised accounts)
      [
        '/revoke-all-sessions/:userId',
        param('userId').isInt({ min: 1 }).withMessage('Invalid user ID').toInt(),
        handleValidation,
        adminAuthController.revokeAllSessions,
      ],
    ],
    get: [
      // List admins
      ['/list', adminAuthController.listAdmins],

      // Activity logs for a specific admin
      [
        '/activity-logs/:adminId',
        param('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        handleValidation,
        adminAuthController.getAdminActivityLogs,
      ],
    ],
    put: [
      // Update permissions
      [
        '/update-permissions',
        body('adminId').isUUID().withMessage('Invalid admin ID (must be UUID)'),
        body('permissions').isArray().withMessage('Permissions must be an array'),
        handleValidation,
        adminAuthController.updatePermissions,
      ],
    ],
  },
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true,
    roles: ['SUPER_ADMIN'],
  }
);

export default router;
