// src/routes/authRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator } from '../config/validationSchemas.js';
import * as authController from '../controllers/authController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutes, wrapRoutesWithValidation } from '../config/routeWrapper.js';

const router = express.Router();

// ✅ Public Authentication Routes — explicitly skip UID enforcement
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      [
        '/login',
        phoneValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }
          authController.login(req, res);
        }
      ],
      [
        '/register',
        phoneValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }
          authController.register(req, res);
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: true // phone is validated anyway via phoneValidator
  }
);

// ✅ Stateless Token + Logout Routes (no RBAC, no UID/Phone needed)
wrapRoutes(
  router,
  [],
  {
    post: [
      ['/token', authController.refreshToken],
      ['/logout', authController.logout]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;
