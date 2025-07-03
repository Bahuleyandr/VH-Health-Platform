// src/routes/auth/authRoutes.js - Core Authentication Routes
// NOTE: These routes are NOT for patient login (patients use Firebase)
// These are for: legacy support, testing, and non-Firebase auth needs

import express from 'express';
import { validationResult } from 'express-validator';
import * as authController from '../../controllers/auth/authController.js';
import { phoneValidator, phoneOtpValidator } from '../../validators/auth/authValidator.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../../config/routeWrapper.js';

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

// Public Authentication Routes - no RBAC required
// NOTE: Patients should use Firebase auth instead (/api/v1/auth/firebase/*)
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Request OTP for Login/Registration
      // Used for: Admin testing, non-patient users, legacy support
      [
        '/request-otp',
        ...phoneValidator,
        handleValidation,
        authController.requestOtp
      ],
      
      // Verify OTP and Login/Register
      // Used for: Admin testing, non-patient users, legacy support
      [
        '/verify-otp',
        ...phoneOtpValidator,
        handleValidation,
        authController.verifyOtp
      ],
      
      // Refresh JWT Token (works for all auth methods)
      ['/refresh-token', authController.refreshToken],
      
      // Logout (works for all auth methods)
      ['/logout', authController.logout],
      
      // Legacy routes (backward compatibility - deprecated)
      [
        '/login',
        ...phoneValidator,
        handleValidation,
        authController.login
      ],
      [
        '/register',
        ...phoneValidator,
        handleValidation,
        authController.register
      ],
      ['/token', authController.refreshToken]
    ],
    
    get: [
      // Authentication Health Check
      ['/health', authController.getHealthStatus],
      
      // Public Authentication Statistics
      ['/stats', authController.getPublicStats]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false
  }
);

export default router;