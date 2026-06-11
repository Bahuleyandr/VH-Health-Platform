// src/controllers/feedbackController.js

import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import { maskPhoneForLog } from '../utils/logMasking.js';
import feedbackService from '../services/feedback/feedbackService.js';
import { resolveDoctorFilterId } from '../services/doctor/doctorRefService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import prisma from '../lib/prisma.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { resolvePhoneFromUID } from '../utils/resolveIdentity.js';
import { success, error } from '../utils/responseHelper.js';
import { isClinical, isAdmin } from '../utils/roleHelpers.js';
import { parseListQuery } from '../utils/listQuery.js';

function tenantOf(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId || DEFAULT_TENANT_ID;
}

function isAdminRole(role) {
  return isAdmin(role) || String(role || '').trim().toUpperCase() === 'SUPER_ADMIN';
}

function canReadOtherFeedback(role) {
  return isAdminRole(role) || isClinical(role);
}

async function resolveAuthenticatedFeedbackPhone(req, requestedPhone) {
  const normalizedRequested = normalizePhone(requestedPhone || '');
  if (isAdminRole(req.user?.role) && normalizedRequested) {
    return normalizedRequested;
  }

  const tokenPhone = normalizePhone(req.user?.phone || '');
  if (tokenPhone) {
    if (normalizedRequested && normalizedRequested !== tokenPhone) {
      const err = new Error('Can only access feedback for yourself');
      err.statusCode = HTTP_STATUS.FORBIDDEN;
      throw err;
    }
    return tokenPhone;
  }

  if (!req.user?.uid) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT phone
       FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    req.user.uid,
    tenantOf(req),
  );
  const resolved = normalizePhone(rows[0]?.phone || '');
  if (normalizedRequested && resolved && normalizedRequested !== resolved) {
    const err = new Error('Can only access feedback for yourself');
    err.statusCode = HTTP_STATUS.FORBIDDEN;
    throw err;
  }
  return resolved;
}

// Submit Feedback using resolved phone
// Supports both star-rating feedback and "Ask a Doubt" (question) from Flutter app.
// NOTE: DB migration required for question column:
//   ALTER TABLE feedback ADD COLUMN IF NOT EXISTS question TEXT;
export async function submitFeedback(req, res) {
  try {
    const phone = await resolveAuthenticatedFeedbackPhone(req, req.body.phone || req.body.phoneNumber);
    const { rating, comment, question } = req.body;

    // phone is required; rating and question are both optional (at least one is expected)
    if (!phone) {
      return error(res, 'Phone is required', 400);
    }

    // INSERT includes `question` column — requires DB migration if column doesn't exist yet
    const result = await feedbackService.submitSimpleFeedback(phone, rating, comment, question);

    success(res, result, 'Feedback submitted successfully');
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode);
    }
    logger.error(err.stack || err.toString());
    error(res, 'Failed to submit feedback');
  }
}

// Fetch Feedback by UID -> resolved to phone
export async function getFeedbackByUID(req, res) {
  try {
    const uid = req.params.uid;
    if (!canReadOtherFeedback(req.user?.role) && String(uid) !== String(req.user?.uid)) {
      return error(res, 'Can only view your own feedback', HTTP_STATUS.FORBIDDEN);
    }

    const resolvedPhone = await resolvePhoneFromUID(uid);

    if (!resolvedPhone) {
      return error(res, 'UID not found in users table', 404);
    }

    const data = await feedbackService.getFeedbackByPhone(resolvedPhone, tenantOf(req));

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
    const phone = await resolveAuthenticatedFeedbackPhone(req, req.query.phone);

    if (!phone) {
      return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await feedbackService.getFeedbackByPhone(phone, tenantOf(req));

    success(res, {
      ...result,
      requestedBy: req.user?.name
    }, 'Feedback history retrieved successfully');

  } catch (err) {
    if (err.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Get Feedback Error:', err);
    error(res, 'Failed to retrieve feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Feedback Statistics for User
export async function getMyStats(req, res) {
  try {
    const phone = await resolveAuthenticatedFeedbackPhone(req, req.query.phone);

    const statistics = await feedbackService.getFeedbackStats(phone, tenantOf(req));

    success(res, {
      statistics,
      requestedBy: req.user?.name
    }, 'Feedback statistics retrieved successfully');

  } catch (err) {
    if (err.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Feedback Stats Error:', err);
    error(res, 'Failed to retrieve feedback statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Feedback Dashboard (Staff access)
export async function getFeedbackDashboard(req, res) {
  try {
    // Role-based access control
    if (!isClinical(req.user?.role) && !isAdminRole(req.user?.role)) {
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

    const dashboardData = await feedbackService.getDashboard(interval, tenantOf(req));

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
    if (!isClinical(req.user?.role) && !isAdminRole(req.user?.role)) {
      return error(res, 'Staff access required for recent feedback', HTTP_STATUS.FORBIDDEN);
    }

    const listQuery = parseListQuery(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const filters = {
      page: listQuery.page,
      limit: listQuery.limit,
      category: req.query.category,
      rating: req.query.rating,
      priority: req.query.priority,
      // Roadmap A9: canonicalize to users.id whichever id space the caller used.
      doctor_id: await resolveDoctorFilterId(prisma, req.query.doctor_id, {
        tenantId: req.tenantId || null,
      }),
      department_id: req.query.department_id
    };

    const result = await feedbackService.getRecentFeedback(filters, req.user?.role, req.user?.id, tenantOf(req));

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
    if (!isClinical(req.user?.role) && !isAdminRole(req.user?.role)) {
      return error(res, 'Staff access required for feedback analytics', HTTP_STATUS.FORBIDDEN);
    }

    const { groupBy = 'day' } = req.query;

    const analyticsData = await feedbackService.getAnalytics(req.user?.role, req.user?.id, groupBy, tenantOf(req));

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
    if (!isAdminRole(req.user?.role)) {
      return error(res, 'Admin access required for feedback reports', HTTP_STATUS.FORBIDDEN);
    }

    const { format = 'json', startDate, endDate } = req.query;

    const reportData = await feedbackService.getReport({ startDate, endDate }, tenantOf(req));

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

  const {
    rating, comment, category = 'general',
    appointment_id, doctor_id, department_id,
    anonymous = false, improvement_suggestions
  } = req.body;

  try {
    const phone = await resolveAuthenticatedFeedbackPhone(req, req.body.phone || req.body.phoneNumber);

    // Check if user exists
    const user = await feedbackService.getUserByPhone(phone, tenantOf(req));

    if (!user) {
      return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
    }

    // Insert feedback via service
    const feedback = await feedbackService.submitFeedback({
      phone, userUid: user.uid, rating, comment, category,
      appointment_id, doctor_id, department_id,
      anonymous, improvement_suggestions
    });

    logger.info(`Feedback submitted: ${maskPhoneForLog(phone)} rated ${rating}/5 (${category}) by ${req.user?.name || 'system'}`);

    success(res, {
      feedbackId: feedback.id,
      rating: feedback.rating,
      category: feedback.category,
      submittedAt: feedback.created_at,
      anonymous: feedback.anonymous,
      submittedBy: req.user?.name
    }, RESPONSE_MESSAGES.FEEDBACK_SUBMITTED);

  } catch (err) {
    if (err.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Submit Feedback Error:', err.stack || err.toString());
    error(res, 'Failed to submit feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Quick Rating (Simple 1-5 star rating)
export async function submitQuickRating(req, res) {
  const { phone, rating, appointment_id, category = 'quick' } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    return error(res, 'Valid rating (1-5) required', HTTP_STATUS.BAD_REQUEST);
  }

  try {
    const normalizedPhone = await resolveAuthenticatedFeedbackPhone(req, phone);
    if (!normalizedPhone) {
      return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await feedbackService.submitQuickRating({
      phone: normalizedPhone,
      uid: req.user?.uid || null,
      rating,
      category,
      appointment_id
    });

    logger.info(`Quick rating submitted: ${maskPhoneForLog(normalizedPhone)} rated ${rating}/5 by ${req.user?.name || 'system'}`);

    success(res, {
      ...result,
      submittedBy: req.user?.name
    }, 'Quick rating submitted successfully');

  } catch (err) {
    if (err.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Quick Rating Error:', err);
    error(res, 'Failed to submit rating', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Respond to Feedback (Staff access)
export async function respondToFeedback(req, res) {
  try {
    // Role-based access control
    if (!isClinical(req.user?.role) && !isAdminRole(req.user?.role)) {
      return error(res, 'Staff access required to respond to feedback', HTTP_STATUS.FORBIDDEN);
    }

    const { feedback_id, response } = req.body;
    const staff_uid = req.user?.uid;

    if (!feedback_id || !response) {
      return error(res, 'Feedback ID and response are required', HTTP_STATUS.BAD_REQUEST);
    }

    // Check if feedback exists and if doctor can respond to their own feedback
    const feedback = await feedbackService.getFeedbackById(feedback_id, tenantOf(req));

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
    if (!isAdminRole(req.user?.role)) {
      return error(res, 'Admin access required to delete feedback', HTTP_STATUS.FORBIDDEN);
    }

    const deletedFeedback = await feedbackService.deleteFeedback(feedback_id, req.user?.uid, reason, tenantOf(req));

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
