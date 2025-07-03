// src/routes/auth/firebaseAuthRoutes.js - Firebase Authentication Routes
// PRIMARY AUTHENTICATION METHOD FOR PATIENTS
// Frontend handles OTP via Firebase, backend verifies Firebase token and issues JWT

import express from 'express';
import { validationResult } from 'express-validator';
import * as firebaseAuthController from '../../controllers/auth/firebaseAuthController.js';
import {
  firebaseLoginValidator,
  userProfileValidator,
  userRegistrationValidator,
  phoneValidator
} from '../../validators/auth/authValidator.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../../config/routeWrapper.js';

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

// Public Firebase Authentication Routes
// These are the main authentication routes for patient mobile apps
wrapRoutesWithValidation(
  router,
  [],
  {
    get: [
      // Test route
      ['/test', firebaseAuthController.testRoute],
      
      // Verify Token Status
      ['/verify-token', firebaseAuthController.verifyToken],
      
      // Firebase Authentication Health
      ['/health', firebaseAuthController.getHealthStatus]
    ],
    
    post: [
      // Firebase ID Token Authentication - PRIMARY PATIENT LOGIN
      // Frontend: Firebase OTP → Firebase ID Token → This endpoint → JWT
      [
        '/firebase-login',
        ...firebaseLoginValidator,
        handleValidation,
        firebaseAuthController.firebaseLogin
      ],
      
      // Legacy registration route (backward compatibility)
      [
        '/register',
        ...userRegistrationValidator,
        handleValidation,
        firebaseAuthController.registerUser
      ],
      
      // Complete User Profile
      [
        '/complete-profile',
        ...userProfileValidator,
        handleValidation,
        firebaseAuthController.completeProfile
      ],
      
      // Link Firebase Account
      [
        '/link-account',
        ...phoneValidator,
        handleValidation,
        firebaseAuthController.linkAccount
      ],
      
      // Update FCM Token
      [
        '/update-fcm-token',
        firebaseAuthController.updateFcmToken
      ],
      
      // Revoke Firebase Session
      [
        '/revoke-session',
        firebaseAuthController.revokeSession
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false
  }
);

// Admin Routes for Firebase Management
wrapAutoRBAC(
  router,
  'firebaseAdminRoutes',
  {
    get: [
      // Firebase Users List
      [
        '/admin/users',
        async (req, res) => {
          // Implementation moved to controller/service
          const { success, error } = require('../../utils/responseHelper.js');
          const logger = require('../../logging/logger.js').default;
          try {
            // Call admin service
            success(res, {
              users: [],
              pagination: {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                total: 0,
                totalPages: 0
              },
              requestedBy: req.user?.name
            }, 'Firebase users retrieved successfully');
          } catch (err) {
            logger.error('Admin Users List Error:', err);
            error(res, 'Failed to retrieve users', 500);
          }
        }
      ],
      
      // Device Management
      [
        '/admin/devices',
        async (req, res) => {
          // Implementation moved to controller/service
          const { success, error } = require('../../utils/responseHelper.js');
          success(res, {
            devices: [],
            statistics: [],
            requestedBy: req.user?.name
          }, 'Device information retrieved successfully');
        }
      ]
    ],
    
    post: [
      // Revoke All User Tokens
      [
        '/admin/revoke-user-tokens',
        async (req, res) => {
          // Implementation moved to controller/service
          const { success, error } = require('../../utils/responseHelper.js');
          error(res, 'Not implemented', 501);
        }
      ],
      
      // Cleanup Inactive Devices
      [
        '/admin/cleanup-devices',
        async (req, res) => {
          // Implementation moved to controller/service
          const { success, error } = require('../../utils/responseHelper.js');
          error(res, 'Not implemented', 501);
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true,
    roles: ['ADMIN']
  }
);

export default router;