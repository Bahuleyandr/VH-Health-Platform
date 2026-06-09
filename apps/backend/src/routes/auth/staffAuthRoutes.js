// src/routes/auth/staffAuthRoutes.js - Staff Authentication Routes
// Employee ID + Password/PIN based authentication for staff mobile app

import express from 'express';
import { validationResult , body } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import * as staffAuthController from '../../controllers/auth/staffAuthController.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import { authRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireDeviceType } from '../../middleware/requireDeviceTypeMiddleware.js';
import { passwordComplexityMiddleware } from '../../validators/passwordValidator.js';
import { staffPinLoginValidator } from '../../validators/auth/adminAuthValidator.js';
import {
  staffPasswordLoginValidator,
  deviceRegistrationValidator,
  pinSetupValidator,
  quickLoginValidator,
  attendanceValidator
} from '../../validators/auth/authValidator.js';

const router = express.Router();
const mobileOnly = requireDeviceType('mobile');

const ownProfileUpdateValidator = [
  body('name')
    .exists({ checkFalsy: true }).withMessage('Name is required')
    .customSanitizer((value) => String(value || '').trim().replace(/\s+/g, ' '))
    .isLength({ min: 2, max: 120 }).withMessage('Name must be between 2 and 120 characters'),
];

const staffPasswordChangeValidator = [
  body('currentPassword')
    .notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .custom((value, { req }) => value !== req.body.currentPassword)
    .withMessage('New password must be different from current password'),
];

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

// Public Staff Authentication Routes
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Initial staff login with Employee ID + Password — rate limited: 5 attempts/15min per IP
      [
        '/login',
        authRateLimiter,
        ...staffPasswordLoginValidator,
        handleValidation,
        staffAuthController.login
      ],

      [
        '/login-pin',
        authRateLimiter,
        ...staffPinLoginValidator,
        handleValidation,
        staffAuthController.pinLogin
      ],

      // Register device for trusted access
      [
        '/register-device',
        authRateLimiter,
        ...deviceRegistrationValidator,
        handleValidation,
        staffAuthController.registerDevice
      ],

      // Quick login with PIN/Biometric — rate limited
      [
        '/quick-login',
        authRateLimiter,
        ...quickLoginValidator,
        handleValidation,
        staffAuthController.quickLogin
      ],
      
      // Verify device token
      [
        '/verify-device',
        body('deviceToken').notEmpty().withMessage('Device token is required'),
        handleValidation,
        staffAuthController.verifyDevice
      ]
    ],
    
    get: [
      // Staff Auth Health Check
      ['/health', staffAuthController.getHealthStatus]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false
  }
);

// Protected Staff Routes (requires authentication)
router.use(jwtAuth);

wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Setup PIN for quick access
      [
        '/setup-pin',
        ...pinSetupValidator,
        handleValidation,
        staffAuthController.setupPin
      ],
      
      // Enable/disable biometric
      [
        '/toggle-biometric',
        body('enabled').isBoolean().withMessage('Enabled must be boolean'),
        body('deviceToken').notEmpty().withMessage('Device token is required'),
        handleValidation,
        staffAuthController.toggleBiometric
      ],
      
      // Mark attendance (check-in)
      [
        '/check-in',
        mobileOnly,
        ...attendanceValidator,
        handleValidation,
        staffAuthController.checkIn
      ],
      
      // Mark attendance (check-out)
      [
        '/check-out',
        mobileOnly,
        ...attendanceValidator,
        handleValidation,
        staffAuthController.checkOut
      ],
      
      // Logout from device
      [
        '/logout',
        body('deviceToken').optional(),
        handleValidation,
        staffAuthController.logout
      ],

      // Change own password. Staff can do this themselves; HR/Admin still own
      // role, phone number, and employment details through staff management.
      [
        '/change-password',
        ...staffPasswordChangeValidator,
        handleValidation,
        passwordComplexityMiddleware,
        staffAuthController.changePassword
      ]
    ],
    
    get: [
      // Get staff profile
      ['/profile', staffAuthController.getProfile],
      
      // Get registered devices
      ['/devices', staffAuthController.getDevices],
      
      // Get today's attendance status
      ['/attendance/today', staffAuthController.getTodayAttendance],
      
      // Get attendance history
      ['/attendance/history', staffAuthController.getAttendanceHistory]
    ],

    patch: [
      // Update self-service account fields. Only display name is accepted here.
      ['/profile', ...ownProfileUpdateValidator, handleValidation, staffAuthController.updateProfile]
    ],
    
    delete: [
      // Remove device
      [
        '/device/:deviceId',
        staffAuthController.removeDevice
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    skipAudit: false
  }
);

export default router;
