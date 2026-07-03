// src/routes/auth/adminOtpRoutes.js - Admin OTP Management Routes
// For monitoring and managing OTP functionality (NOT for admin login)

import express from 'express';
import { validationResult, body, query } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as adminOtpController from '../../controllers/auth/adminOtpController.js';
import { error } from '../../utils/responseHelper.js';
import {
  analyticsValidator,
  otpLogsValidator,
  adminOtpValidator,
  configUpdateValidator,
  forceSendOtpValidator,
  bulkDeleteValidator
} from '../../validators/auth/authValidator.js';

const router = express.Router();

// Validation middleware helper
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, {
      topLevel: { errors: errors.array() },
    });
  }
  next();
};

// ADMIN ROUTES - Full RBAC protection (ADMIN only)
wrapAutoRBAC(router, 'ALL', {
  get: [
    // OTP Usage Analytics
    [
      '/analytics',
      ...analyticsValidator,
      handleValidation,
      adminOtpController.getAnalytics
    ],
    
    // OTP Security Alerts
    ['/security-alerts', adminOtpController.getSecurityAlerts],
    
    // Active OTP Sessions
    [
      '/active-sessions',
      query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be 1-500'),
      handleValidation,
      adminOtpController.getActiveSessions
    ],
    
    // OTP Logs with Advanced Filtering
    [
      '/logs',
      ...otpLogsValidator,
      handleValidation,
      adminOtpController.getOtpLogs
    ],
    
    // OTP Status Check for specific phone
    [
      '/status/:phone',
      query('purpose').optional().isString().withMessage('Purpose must be string'),
      handleValidation,
      adminOtpController.getOtpStatus
    ]
  ],
  
  post: [
    // Revoke OTP for User
    [
      '/revoke-otp',
      ...adminOtpValidator,
      body('reason').notEmpty().withMessage('Reason is required for revocation'),
      handleValidation,
      adminOtpController.revokeOtp
    ],
    
    // Cleanup OTP Logs
    [
      '/cleanup-logs',
      body('olderThanDays').isInt({ min: 1, max: 365 }).withMessage('olderThanDays must be 1-365'),
      handleValidation,
      adminOtpController.cleanupLogs
    ],
    
    // Update OTP Configuration
    [
      '/update-config',
      ...configUpdateValidator,
      handleValidation,
      adminOtpController.updateConfiguration
    ],
    
    // Force Send OTP
    [
      '/force-send-otp',
      ...forceSendOtpValidator,
      handleValidation,
      adminOtpController.forceSendOtp
    ]
  ],
  
  delete: [
    // Bulk Delete OTP Sessions
    [
      '/bulk-delete-sessions',
      ...bulkDeleteValidator,
      handleValidation,
      adminOtpController.bulkDeleteSessions
    ]
  ]
});

export default router;
