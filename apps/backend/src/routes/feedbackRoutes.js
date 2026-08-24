// src/routes/feedbackRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { feedbackValidator } from '../config/validationSchemas.js';
import * as feedbackController from '../controllers/feedbackController.js';
import logger from '../logging/logger.js';
import { sanitizeFeedbackFields } from '../middleware/sanitizeMiddleware.js';
import { success } from '../utils/responseHelper.js';

const router = express.Router();
logger.info('✅ feedbackRoutes loaded with RBAC protection');

/**
 * ✅ Feedback Routes with RBAC protection
 * Enhanced patient feedback system with comprehensive management
 * RBAC-controlled via `feedbackRoutes` config
 */
wrapAutoRBAC(
  router,
  'feedbackRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          success(res, {
            message: 'Feedback routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.name || 'Unknown'
          }, 'Feedback routes operational');
        }
      ],

      // Legacy route from deprecated version (maintained for backward compatibility)
      ['/uid/:uid', feedbackController.getFeedbackByUID],

      // 📋 Get User's Feedback History
      ['/my-feedback', feedbackController.getMyFeedback],

      // 📊 Feedback Statistics for User
      ['/my-stats', feedbackController.getMyStats],

      // 📊 Feedback Dashboard (Staff access)
      ['/dashboard', feedbackController.getFeedbackDashboard],

      // 📋 Recent Feedback with Filtering (Staff access)
      ['/recent', feedbackController.getRecentFeedback],

      // 📈 Feedback Analytics (Staff access)
      ['/analytics', feedbackController.getFeedbackAnalytics],

      // 📊 Comprehensive Feedback Report (Admin only)
      ['/report', feedbackController.getFeedbackReport]
    ],

    post: [
      // 📝 Submit Feedback (Enhanced from deprecated version)
      ['/', feedbackValidator, sanitizeFeedbackFields, feedbackController.submitFeedbackEnhanced],

      // 👍 Quick Rating (Simple 1-5 star rating)
      ['/quick-rating', feedbackController.submitQuickRating],

      // 📈 NPS Rating (0-10, stored separately from 1-5 star feedback)
      ['/nps', sanitizeFeedbackFields, feedbackController.submitNpsResponse]

      // NOTE: `POST /respond` (staff reply to an Ask-a-Doubt question) was
      // removed in the re-audit I tenancy sweep — its service wrote to
      // `feedback_responses`, a table that exists in no migration, so the
      // path always 500'd and stored nothing. Staff follow-up belongs on the
      // `/nps` service-recovery surface above.
    ],

    delete: [
      // 🗑️ Delete Inappropriate Feedback (Admin only)
      ['/:feedback_id', feedbackController.deleteFeedback]
    ]
  },
  {
    requireUID: true,        // Require user authentication
    requirePhone: false,     // Phone not required for all operations (extracted from JWT)
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR', 'PATIENT', 'NURSE'] // All authenticated users can access with appropriate restrictions
  }
);

export default router;
