// src/routes/auth/firebaseAuthRoutes.js - Firebase Authentication Routes
// PRIMARY AUTHENTICATION METHOD FOR PATIENTS
// Frontend handles OTP via Firebase, backend verifies Firebase token and issues JWT

import express from 'express';
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import * as firebaseAuthController from '../../controllers/auth/firebaseAuthController.js';
import jwtAuth, { enforceFullScope } from '../../middleware/jwtMiddleware.js';
import { otpRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { error } from '../../utils/responseHelper.js';
import {
  firebaseLoginValidator,
  userProfileValidator,
  userRegistrationValidator,
  phoneValidator
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

const requireAuthenticatedPhoneBinding = (req, res, next) => {
  const tokenPhone = normalizePhone(req.user?.phone);
  const requestedPhone = normalizePhone(req.body?.phone);

  if (!tokenPhone || !requestedPhone || tokenPhone !== requestedPhone) {
    const message = 'Authenticated user does not match requested phone';
    return error(res, message, HTTP_STATUS.FORBIDDEN, {
      topLevel: {
        error: message,
        code: 'FIREBASE_PHONE_MISMATCH'
      }
    });
  }

  req.body.phone = tokenPhone;
  return next();
};

const requireFirebaseSelfServiceAuth = [
  jwtAuth,
  enforceFullScope,
  requireAuthenticatedPhoneBinding
];

const requireLegacyFirebaseRegisterAllowed = (_req, res, next) => {
  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const explicitlyEnabled = String(process.env.ENABLE_LEGACY_FIREBASE_REGISTER || '').toLowerCase() === 'true';

  if (isProduction || !explicitlyEnabled) {
    const message = 'Legacy Firebase registration is disabled. Use Firebase ID-token login.';
    return error(res, message, HTTP_STATUS.FORBIDDEN, {
      topLevel: {
        error: message,
        code: 'FIREBASE_LEGACY_REGISTER_DISABLED'
      }
    });
  }

  return next();
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
      // P0 Security: Per-phone OTP rate limiting (3 req / 10 min)
      [
        '/firebase-login',
        otpRateLimiter,
        ...firebaseLoginValidator,
        handleValidation,
        firebaseAuthController.firebaseLogin
      ],
      
      // Legacy registration route (backward compatibility)
      [
        '/register',
        requireLegacyFirebaseRegisterAllowed,
        ...userRegistrationValidator,
        handleValidation,
        firebaseAuthController.registerUser
      ],
      
      // Complete User Profile
      [
        '/complete-profile',
        jwtAuth,
        enforceFullScope,
        ...userProfileValidator,
        handleValidation,
        requireAuthenticatedPhoneBinding,
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
        ...requireFirebaseSelfServiceAuth,
        firebaseAuthController.updateFcmToken
      ],
      
      // Revoke Firebase Session — ADMIN force-logout of an arbitrary UID.
      // The target is named in the body, so this MUST stay ADMIN-only.
      [
        '/revoke-session',
        jwtAuth,
        enforceFullScope,
        requireRole('ADMIN'),
        firebaseAuthController.revokeSession
      ],

      // Revoke MY Firebase Session — self-service logout for the patient app.
      // Authentication is the whole authorization story here: the controller
      // derives the Firebase UID from the JWT subject, so there is no target to
      // authorize and nothing for a role gate to protect. Unlike the sibling
      // self-service routes it takes no body at all, so it deliberately does
      // NOT use requireFirebaseSelfServiceAuth (whose phone binding would force
      // the client to put its phone on the wire for no security gain).
      [
        '/revoke-my-session',
        jwtAuth,
        enforceFullScope,
        firebaseAuthController.revokeMySession
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false
  }
);

export default router;
