// src/routes/authRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator } from '../config/validationSchemas.js';
import * as authController from '../controllers/authController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutes, wrapRoutesWithValidation } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Public Authentication Routes (Login / Register)
 * No RBAC, UID, or Phone validation middleware — only validator + controller
 */
wrapRoutesWithValidation(router, [], {
  post: [
    ['/login', phoneValidator, (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED,
        });
      }
      authController.login(req, res);
    }],
    ['/register', phoneValidator, (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED,
        });
      }
      authController.register(req, res);
    }]
  ]
}, {
  skipRBAC: true,
  requireUID: false,
  requirePhone: false
});

/**
 * ✅ Stateless Token + Logout Routes
 */
wrapRoutes(router, [], {
  post: [
    ['/token', authController.refreshToken],
    ['/logout', authController.logout]
  ]
}, {
  skipRBAC: true,
  requireUID: false,
  requirePhone: false
});

export default router;
