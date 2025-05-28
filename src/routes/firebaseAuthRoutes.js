// src/routes/firebaseAuthRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import {
  phoneValidator,
  userProfileValidator,
} from '../config/validationSchemas.js';
import * as firebaseAuthController from '../controllers/firebaseAuthController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Firebase Auth Routes (Public)
 * - Firebase Login with phone
 * - Firebase Register with profile
 */
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      [
        '/firebase-login',
        phoneValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED,
            });
          }
          return firebaseAuthController.firebaseLogin(req, res);
        },
      ],
      [
        '/register',
        userProfileValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED,
            });
          }
          return firebaseAuthController.registerUser(req, res);
        },
      ],
    ],
  },
  {
    requireUID: false,
    requirePhone: false,
  },
);

export default router;
