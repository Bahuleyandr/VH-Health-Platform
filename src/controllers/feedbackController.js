// src/controllers/feedbackController.js

import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { resolvePhoneFromRequest, resolvePhoneFromUID } from '../utils/resolveIdentity.js';
import { success, error } from '../utils/responseHelper.js';
import { isClinical, isAdmin } from '../utils/roleHelpers.js';
import feedbackService from '../services/feedback/feedbackService.js';

// Submit Feedback using resolved phone
// Supports both star-rating feedback and "Ask a Doubt" (question) from Flutter app.
// NOTE: DB migration required for question column:
//   ALTER TABLE feedback ADD COLUMN IF NOT EXISTS question TEXT;
export async function submitFeedback(req, res) {
  try {
    const phone = resolvePhoneFromRequest(req);
    const { rating, comment, question } = req.body;

    // phone is required; rating and question are both optional (at least one is expected)
    if (!phone) {
      return error(res, 'Phone is required', 400);
    }

    // INSERT includes `question` column — requires DB migration if column doesn't exist yet
    const result = await feedbackService.submitSimpleFeedback(phone, rating, comment, question);

    success(res, result, 'Feedback submitted successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to submit feedback');
  }
}

// Fetch Feedback by UID -> resolved to phone
export async function getFeedbackByUID(req, res) {
  try {
    const uid = req.params.uid;
    const resolvedPhone = await resolvePhoneFromUID(uid);

    if (!resolvedPhone) {
      return error(res, 'UID not found in users table', 404);
    }

    const data = await feedbackService.getFeedbackByPhone(resolvedPhone);

    if (data.totalCount === 0) {
      return error(res, 'No feedback found for this phone', 404);
    }

    return success(res, { feedback: data.feedback }, 'Feedback retrieved successfully');
  } catch (err) {
    logger.error('Get Feedback By UID Error:', err);
    return error(res, 'Internal server error');
  }
}

// Get User's Feedback History
export async function getMyFeedback(req, res) {
  try {
    const phone = normalizePhone(req.user?.phone || req.query.phone);

    if (!phone) {
      return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
    }

    // Role-based access control - users can only see their own feedback
    if (req.user?.phone && normalizePhone(req.user.phone) !== phone && req.user?.role !== 'ADMIN') {
      return error(res, 'Can only view your own feedback', HTTP_STATUS.FORBIDDEN);
    }

    const result = await feedbackService.getFeedbackByPhone(phone);

    success(res, {
      ...result,
      requestedBy: req.user?.name
    }, 'Feedback history retrieved successfully');

  } catch (err) {
    logger.error('Get Feedback Error:', err);
    error(res, 'Failed to retrieve feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Feedback Statistics for User
export async function getMyStats(req, res) {
  try {
    const phone = normalizePhone(req.user?.phone || req.query.phone);

    // Role-based access control
    if (req.user?.phone && normalizePhone(req.user.phone) !== phone && req.user?.role !== 'ADMIN') {
      return error(res, 'Can only view your own statistics', HTTP_STATUS.FORBIDDEN);
    }

    const statistics = await feedbackService.getFeedbackStats(phone);

    success(res, {
      statistics,
      requestedBy: req.user?.name
    }, 'Feedback statistics retrieved successfully');

  } catch (err) {
    logger.error('Feedback Stats Error:', err);
    error(res, 'Failed to retrieve feedback statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Feedback Dashboard (Staff access)
export async function getFeedbackDashboard(req, res) {
  try {
    // Role-based access control
    if (!isClinical(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Staff access required for feedback dashboard', HTTP_STATUS.FORBIDDEN);
    }

    const { timeframe = '30d' } = req.query;

    let interval;
    switch (timeframe) {
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      case '90d': interval = '90 days'; break;
      default: interval = '30 days';
    }

    const dashboardData = await feedbackService.getDashboard(interval);

    success(res, {
      timeframe,
      ...dashboardData,
      requestedBy: req.user?.name,
      generatedAt: new Date().toISOString()
    }, 'Feedback dashboard data retrieved successfully');

  } catch (err) {
    logger.error('Feedback Dashboard Error:', err);
    error(res, 'Failed to load feedback dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Recent Feedback with Filtering (Staff access)
export async function getRecentFeedback(req, res) {
  try {
    // Role-based access control
    if (!isClinical(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Staff access required for recent feedback', HTTP_STATUS.FORBIDDEN);
    }

    const filters = {
      page: Math.max(parseInt(req.query.page, 10) || 1, 1),
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100),
      category: req.query.category,
      rating: req.query.rating,
      priority: req.query.priority,
      doctor_id: req.query.doctor_id,
      department_id: req.query.department_id
    };

    const result = await feedbackService.getRecentFeedback(filters, req.user?.role, req.user?.id);

    success(res, {
      ...result,
      filters: {
        category: filters.category,
        rating: filters.rating,
        priority: filters.priority,
        doctor_id: filters.doctor_id,
        department_id: filters.department_id
      },
      requestedBy: req.user?.name
    }, 'Recent feedback retrieved successfully');

  } catch (err) {
    logger.error('Recent Feedback Error:', err);
    error(res, 'Failed to fetch recent feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Feedback Analytics (Staff access)
export async function getFeedbackAnalytics(req, res) {
  try {
    // Role-based access control
    if (!isClinical(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Staff access required for feedback analytics', HTTP_STATUS.FORBIDDEN);
    }

    const { groupBy = 'day' } = req.query;

    const analyticsData = await feedbackService.getAnalytics(req.user?.role, req.user?.id, groupBy);

    success(res, {
      ...analyticsData,
      requestedBy: req.user?.name,
      analysisDate: new Date().toISOString()
    }, 'Feedback analytics generated successfully');

  } catch (err) {
    logger.error('Feedback Analytics Error:', err);
    error(res, 'Failed to generate analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Comprehensive Feedback Report (Admin only)
export async function getFeedbackReport(req, res) {
  try {
    // Role-based access control
    if (req.user?.role !== 'ADMIN') {
      return error(res, 'Admin access required for feedback reports', HTTP_STATUS.FORBIDDEN);
    }

    const { format = 'json', startDate, endDate } = req.query;

    const reportData = await feedbackService.getReport({ startDate, endDate });

    if (format === 'csv') {
      let csv = 'Metric,Value\n';
      Object.entries(reportData).forEach(([key, value]) => {
        csv += `${key},${value}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=feedback_report.csv');
      return res.send(csv);
    }

    success(res, {
      reportData,
      reportPeriod: { startDate, endDate },
      requestedBy: req.user?.name,
      generatedAt: new Date().toISOString()
    }, 'Feedback report generated successfully');

  } catch (err) {
    logger.error('Feedback Report Error:', err);
    error(res, 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Submit Feedback (Enhanced from deprecated version)
export async function submitFeedbackEnhanced(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
  }

  const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
  const {
    rating, comment, category = 'general',
    appointment_id, doctor_id, department_id,
    anonymous = false, improvement_suggestions
  } = req.body;

  try {
    // Role-based access control - users can only submit feedback for themselves
    if (req.user?.phone && normalizePhone(req.user.phone) !== phone && req.user?.role !== 'ADMIN') {
      return error(res, 'Can only submit feedback for yourself', HTTP_STATUS.FORBIDDEN);
    }

    // Check if user exists
    const user = await feedbackService.getUserByPhone(phone);

    if (!user) {
      return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
    }

    // Insert feedback via service
    const feedback = await feedbackService.submitFeedback({
      phone, userUid: user.uid, rating, comment, category,
      appointment_id, doctor_id, department_id,
      anonymous, improvement_suggestions
    });

    logger.info(`Feedback submitted: ${phone} rated ${rating}/5 (${category}) by ${req.user?.name || 'system'}`);

    success(res, {
      feedbackId: feedback.id,
      rating: feedback.rating,
      category: feedback.category,
      submittedAt: feedback.created_at,
      anonymous: feedback.anonymous,
      submittedBy: req.user?.name
    }, RESPONSE_MESSAGES.FEEDBACK_SUBMITTED);

  } catch (err) {
    logger.error('Submit Feedback Error:', err.stack || err.toString());
    error(res, 'Failed to submit feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Quick Rating (Simple 1-5 star rating)
export async function submitQuickRating(req, res) {
  const { phone, rating, appointment_id, category = 'quick' } = req.body;

  if (!phone || !rating || rating < 1 || rating > 5) {
    return error(res, 'Valid phone and rating (1-5) required', HTTP_STATUS.BAD_REQUEST);
  }

  try {
    const normalizedPhone = normalizePhone(phone);

    // Role-based access control
    if (req.user?.phone && normalizePhone(req.user.phone) !== normalizedPhone && req.user?.role !== 'ADMIN') {
      return error(res, 'Can only submit rating for yourself', HTTP_STATUS.FORBIDDEN);
    }

    const result = await feedbackService.submitQuickRating({
      phone: normalizedPhone, rating, category, appointment_id
    });

    logger.info(`Quick rating submitted: ${normalizedPhone} rated ${rating}/5 by ${req.user?.name || 'system'}`);

    success(res, {
      ...result,
      submittedBy: req.user?.name
    }, 'Quick rating submitted successfully');

  } catch (err) {
    logger.error('Quick Rating Error:', err);
    error(res, 'Failed to submit rating', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Respond to Feedback (Staff access)
export async function respondToFeedback(req, res) {
  try {
    // Role-based access control
    if (!isClinical(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Staff access required to respond to feedback', HTTP_STATUS.FORBIDDEN);
    }

    const { feedback_id, response } = req.body;
    const staff_uid = req.user?.uid;

    if (!feedback_id || !response) {
      return error(res, 'Feedback ID and response are required', HTTP_STATUS.BAD_REQUEST);
    }

    // Check if feedback exists and if doctor can respond to their own feedback
    const feedback = await feedbackService.getFeedbackById(feedback_id);

    if (!feedback) {
      return error(res, 'Feedback not found', HTTP_STATUS.NOT_FOUND);
    }

    // Doctors can only respond to their own feedback
    if (req.user?.role === 'DOCTOR' && feedback.doctor_id !== req.user.id) {
      return error(res, 'Can only respond to feedback about yourself', HTTP_STATUS.FORBIDDEN);
    }

    // Insert response via service
    const result = await feedbackService.respondToFeedback(feedback_id, staff_uid, response);

    logger.info(`Staff ${req.user?.name} responded to feedback ID: ${feedback_id}`);

    success(res, {
      response: result,
      respondedBy: req.user?.name
    }, 'Response submitted successfully');

  } catch (err) {
    logger.error('Feedback Response Error:', err);
    error(res, 'Failed to submit response', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Delete Inappropriate Feedback (Admin only)
export async function deleteFeedback(req, res) {
  try {
    const { feedback_id } = req.params;
    const { reason = 'Admin deletion' } = req.body;

    // Role-based access control
    if (req.user?.role !== 'ADMIN') {
      return error(res, 'Admin access required to delete feedback', HTTP_STATUS.FORBIDDEN);
    }

    const deletedFeedback = await feedbackService.deleteFeedback(feedback_id, req.user?.uid, reason);

    if (!deletedFeedback) {
      return error(res, 'Feedback not found', HTTP_STATUS.NOT_FOUND);
    }

    logger.info(`Admin ${req.user?.name} deleted feedback ID: ${feedback_id} - Reason: ${reason}`);

    success(res, {
      deletedFeedback,
      reason,
      deletedBy: req.user?.name
    }, 'Feedback deleted successfully');

  } catch (err) {
    logger.error('Delete Feedback Error:', err);
    error(res, 'Failed to delete feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
