// src/routes/feedbackRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import * as feedbackController from '../controllers/feedbackController.js';
import { feedbackValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Feedback Routes (RBAC-controlled via `feedbackRoutes`)
 * - Submit feedback (with phone normalization & validation)
 * - Fetch feedback by UID
 */
wrapAutoRBAC(router, 'feedbackRoutes', {
  post: [
    [
      '/',
      feedbackValidator,
      (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED,
          });
        }

        return feedbackController.submitFeedback(req, res);
      },
    ],
  ],
  get: [['/uid/:uid', feedbackController.getFeedbackByUID]],
});

export default router;
