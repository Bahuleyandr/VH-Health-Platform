// src/routes/auth/otpRoutes.js - Core OTP Routes
// NOTE: These routes are NOT for patient login (patients use Firebase OTP)
// These are for: Admin override, testing, non-Firebase OTP needs

import express from 'express';
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import * as otpController from '../../controllers/auth/otpController.js';
import { phoneValidator, phoneOtpValidator } from '../../validators/auth/authValidator.js';

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

// PUBLIC OTP ROUTES (Not for patient authentication)
// Patients should use Firebase OTP through the mobile app
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Request OTP - stores in database (doesn't send SMS)
      // Used for: Admin testing, special cases
      [
        '/request-otp',
        ...phoneValidator,
        handleValidation,
        otpController.requestOtp
      ],
      
      // Verify OTP - checks against database
      // Used for: Admin testing, special cases
      [
        '/verify-otp',
        ...phoneOtpValidator,
        handleValidation,
        otpController.verifyOtp
      ]
    ],
    
    get: [
      ['/health', otpController.getHealthStatus]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;