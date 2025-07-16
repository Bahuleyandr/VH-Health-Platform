// src/routes/auth/staffAuthRoutes.js - Staff Authentication Routes
// Employee ID + Password/PIN based authentication for staff mobile app

import express from 'express';
import { validationResult , body } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import * as staffAuthController from '../../controllers/auth/staffAuthController.js';
import {
  staffPasswordLoginValidator,
  deviceRegistrationValidator,
  pinSetupValidator,
  quickLoginValidator,
  attendanceValidator
} from '../../validators/auth/authValidator.js';


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

// Public Staff Authentication Routes
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      // Initial staff login with Employee ID + Password
      [
        '/login',
        ...staffPasswordLoginValidator,
        handleValidation,
        staffAuthController.login
      ],
      
      // Register device for trusted access
      [
        '/register-device',
        ...deviceRegistrationValidator,
        handleValidation,
        staffAuthController.registerDevice
      ],
      
      // Quick login with PIN/Biometric
      [
        '/quick-login',
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
// Note: In production, import authenticateToken from '../../middleware/auth.js'
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: 'Authorization token required'
    });
  }
  
  // In production, this would verify the JWT and extract user info
  // For now, pass through with placeholder user
  req.user = { uid: 1 };
  next();
};

// Protected Staff Routes (requires authentication)
router.use(authenticateToken); // Apply auth middleware

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
        ...attendanceValidator,
        handleValidation,
        staffAuthController.checkIn
      ],
      
      // Mark attendance (check-out)
      [
        '/check-out',
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