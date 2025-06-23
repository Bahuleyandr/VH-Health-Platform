// src/routes/firebaseAuthRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator, userProfileValidator } from '../config/validationSchemas.js';
import * as firebaseAuthController from '../controllers/firebaseAuthController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
// Remove the import for wrapRoutesWithValidation for now
// import { wrapRoutesWithValidation } from '../config/routeWrapper.js';

const router = express.Router();

// --- Define routes the standard Express way for debugging ---

// Handle Firebase Login
router.post(
  '/firebase-login',
  phoneValidator,
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }
    // If validation passes, call the controller
    firebaseAuthController.firebaseLogin(req, res);
  }
);

// Handle Firebase Registration
router.post(
    '/register',
    userProfileValidator,
    (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      firebaseAuthController.registerUser(req, res);
    }
  );


export default router;