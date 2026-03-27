// src/controllers/feedbackController.js

import { validationResult } from 'express-validator';
import db from '../config/database.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { resolvePhoneFromRequest, resolvePhoneFromUID } from '../utils/resolveIdentity.js';
import { success, error } from '../utils/responseHelper.js';

// ✅ Submit Feedback using resolved phone
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
    const result = await db.query(
      'INSERT INTO feedback (phone, rating, comment, question) VALUES ($1, $2, $3, $4) RETURNING id, phone, rating, comment, question, created_at',
      [phone, rating || null, comment || null, question || null]
    );

    success(res, result.rows[0], 'Feedback submitted successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to submit feedback');
  }
}

// ✅ Fetch Feedback by UID → resolved to phone
export async function getFeedbackByUID(req, res) {
  try {
    const uid = req.params.uid;
    const resolvedPhone = await resolvePhoneFromUID(uid);

    if (!resolvedPhone) {
      return error(res, 'UID not found in users table', 404);
    }

    const result = await db.query('SELECT id, phone, rating, comment, created_at FROM feedback WHERE phone = $1', [resolvedPhone]);

    if (result.rows.length === 0) {
      return error(res, 'No feedback found for this phone', 404);
    }

    return success(res, { feedback: result.rows }, 'Feedback retrieved successfully');
  } catch (err) {
    logger.error('Get Feedback By UID Error:', err);
    return error(res, 'Internal server error');
  }
}

// 📋 Get User's Feedback History
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

    const result = await db.query(
      `SELECT
        f.id, f.rating, f.comment, f.category, f.created_at,
        f.anonymous, f.improvement_suggestions, f.response_status,
        f.responded_at,
        d.name as doctor_name,
        dept.name as department_name,
        a.appointment_date as appointment_date
       FROM feedback f
       LEFT JOIN doctors d ON f.doctor_id = d.id
       LEFT JOIN departments dept ON f.department_id = dept.id
       LEFT JOIN appointments a ON f.appointment_id = a.id
       WHERE f.phone = $1
       ORDER BY f.created_at DESC`,
      [phone]
    );

    const averageRating = result.rows.length > 0
      ? (result.rows.reduce((sum, f) => sum + f.rating, 0) / result.rows.length).toFixed(1)
      : null;

    success(res, {
      feedback: result.rows,
      totalCount: result.rows.length,
      averageRating,
      requestedBy: req.user?.name
    }, 'Feedback history retrieved successfully');

  } catch (err) {
    logger.error('Get Feedback Error:', err);

    // Fallback response
    success(res, {
      feedback: [],
      totalCount: 0,
      averageRating: null,
      note: 'Could not retrieve feedback - feedback table may not exist',
      requestedBy: req.user?.name
    }, 'Feedback history retrieved (empty - table may not exist)');
  }
}

// 📊 Feedback Statistics for User
export async function getMyStats(req, res) {
  try {
    const phone = normalizePhone(req.user?.phone || req.query.phone);

    // Role-based access control
    if (req.user?.phone && normalizePhone(req.user.phone) !== phone && req.user?.role !== 'ADMIN') {
      return error(res, 'Can only view your own statistics', HTTP_STATUS.FORBIDDEN);
    }

    const stats = await db.query(
      `SELECT
        COUNT(*) as total_feedback,
        ROUND(AVG(rating), 2) as average_rating,
        COUNT(*) FILTER (WHERE rating >= 4) as positive_feedback,
        COUNT(*) FILTER (WHERE rating <= 2) as negative_feedback,
        COUNT(*) FILTER (WHERE rating = 3) as neutral_feedback,
        array_agg(DISTINCT category) as categories_used,
        MIN(created_at) as first_feedback,
        MAX(created_at) as latest_feedback,
        COUNT(*) FILTER (WHERE response_status = 'responded') as responded_count
       FROM feedback
       WHERE phone = $1`,
      [phone]
    );

    success(res, {
      statistics: stats.rows[0],
      requestedBy: req.user?.name
    }, 'Feedback statistics retrieved successfully');

  } catch (err) {
    logger.error('Feedback Stats Error:', err);

    // Fallback with mock data
    success(res, {
      statistics: {
        total_feedback: 0,
        average_rating: null,
        positive_feedback: 0,
        negative_feedback: 0,
        neutral_feedback: 0,
        categories_used: [],
        first_feedback: null,
        latest_feedback: null,
        responded_count: 0
      },
      note: 'Statistics unavailable - feedback table may not exist',
      requestedBy: req.user?.name
    }, 'Feedback statistics retrieved (empty - table may not exist)');
  }
}

// 📊 Feedback Dashboard (Staff access)
export async function getFeedbackDashboard(req, res) {
  try {
    // Role-based access control
    if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
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

    // Overall statistics
    const overallStats = await db.query(`
      SELECT
        COUNT(*) as total_feedback,
        ROUND(AVG(rating), 2) as average_rating,
        COUNT(*) FILTER (WHERE rating >= 4) as positive_count,
        COUNT(*) FILTER (WHERE rating <= 2) as negative_count,
        COUNT(DISTINCT phone) as unique_users,
        COUNT(*) FILTER (WHERE response_status = 'responded') as responded_count
      FROM feedback
      WHERE created_at > NOW() - INTERVAL '${interval}'
    `);

    // Feedback by category
    const categoryStats = await db.query(`
      SELECT
        category,
        COUNT(*) as count,
        ROUND(AVG(rating), 2) as avg_rating
      FROM feedback
      WHERE created_at > NOW() - INTERVAL '${interval}'
      GROUP BY category
      ORDER BY count DESC
    `);

    // Daily trend
    const dailyTrend = await db.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as feedback_count,
        ROUND(AVG(rating), 2) as avg_rating
      FROM feedback
      WHERE created_at > NOW() - INTERVAL '${interval}'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `);

    success(res, {
      timeframe,
      overallStats: overallStats.rows[0],
      categoryBreakdown: categoryStats.rows,
      dailyTrend: dailyTrend.rows,
      requestedBy: req.user?.name,
      generatedAt: new Date().toISOString()
    }, 'Feedback dashboard data retrieved successfully');

  } catch (err) {
    logger.error('Feedback Dashboard Error:', err);

    // Fallback with mock data
    success(res, {
      timeframe: req.query.timeframe || '30d',
      overallStats: {
        total_feedback: 0,
        average_rating: 0,
        positive_count: 0,
        negative_count: 0,
        unique_users: 0,
        responded_count: 0
      },
      categoryBreakdown: [],
      dailyTrend: [],
      note: 'Dashboard data unavailable - feedback table may not exist',
      requestedBy: req.user?.name,
      generatedAt: new Date().toISOString()
    }, 'Feedback dashboard retrieved (empty - table may not exist)');
  }
}

// 📋 Recent Feedback with Filtering (Staff access)
export async function getRecentFeedback(req, res) {
  try {
    // Role-based access control
    if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
      return error(res, 'Staff access required for recent feedback', HTTP_STATUS.FORBIDDEN);
    }

    const {
      page = 1, limit = 50, category, rating, priority = 'all',
      doctor_id, department_id
    } = req.query;

    const offset = (page - 1) * limit;
    let whereClause = 'WHERE 1=1';
    const params = [limit, offset];
    let paramIndex = 3;

    if (category) {
      whereClause += ` AND f.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (rating) {
      whereClause += ` AND f.rating = $${paramIndex}`;
      params.push(parseInt(rating));
      paramIndex++;
    }

    if (priority === 'critical') {
      whereClause += ` AND f.rating <= 2`;
    } else if (priority === 'positive') {
      whereClause += ` AND f.rating >= 4`;
    }

    if (doctor_id) {
      whereClause += ` AND f.doctor_id = $${paramIndex}`;
      params.push(doctor_id);
      paramIndex++;
    }

    if (department_id) {
      whereClause += ` AND f.department_id = $${paramIndex}`;
      params.push(department_id);
      paramIndex++;
    }

    // Filter by user role - doctors see only their feedback
    if (req.user?.role === 'DOCTOR') {
      whereClause += ` AND f.doctor_id = $${paramIndex}`;
      params.push(req.user.id);
      paramIndex++;
    }

    const feedback = await db.query(`
      SELECT
        f.id, f.phone, f.rating, f.comment, f.category, f.created_at,
        f.anonymous, f.improvement_suggestions, f.response_status,
        u.name as user_name,
        d.name as doctor_name,
        dept.name as department_name,
        CASE
          WHEN f.rating <= 2 THEN 'critical'
          WHEN f.rating >= 4 THEN 'positive'
          ELSE 'neutral'
        END as priority_level
      FROM feedback f
      LEFT JOIN users u ON f.phone = u.phone
      LEFT JOIN doctors d ON f.doctor_id = d.id
      LEFT JOIN departments dept ON f.department_id = dept.id
      ${whereClause}
      ORDER BY f.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const total = await db.query(
      `SELECT COUNT(*) FROM feedback f ${whereClause}`,
      params.slice(2)
    );

    success(res, {
      feedback: feedback.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total.rows[0].count),
        totalPages: Math.ceil(total.rows[0].count / limit)
      },
      filters: { category, rating, priority, doctor_id, department_id },
      requestedBy: req.user?.name
    }, 'Recent feedback retrieved successfully');

  } catch (err) {
    logger.error('Recent Feedback Error:', err);
    error(res, 'Failed to fetch recent feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// 📈 Feedback Analytics (Staff access)
export async function getFeedbackAnalytics(req, res) {
  try {
    // Role-based access control
    if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
      return error(res, 'Staff access required for feedback analytics', HTTP_STATUS.FORBIDDEN);
    }

    const { startDate, endDate, groupBy = 'day' } = req.query;

    // Doctor performance rankings
    let doctorQuery = `
      SELECT
        d.id, d.name,
        COUNT(f.id) as feedback_count,
        ROUND(AVG(f.rating), 2) as average_rating,
        COUNT(*) FILTER (WHERE f.rating >= 4) as positive_feedback,
        COUNT(*) FILTER (WHERE f.rating <= 2) as negative_feedback
      FROM doctors d
      LEFT JOIN feedback f ON d.id = f.doctor_id
      WHERE f.created_at > NOW() - INTERVAL '30 days'
    `;

    // If user is a doctor, only show their own analytics
    if (req.user?.role === 'DOCTOR') {
      doctorQuery += ` AND d.id = ${req.user.id}`;
    }

    doctorQuery += `
      GROUP BY d.id, d.name
      HAVING COUNT(f.id) > 0
      ORDER BY average_rating DESC, feedback_count DESC
    `;

    const doctorRankings = await db.query(doctorQuery);

    // Department performance (admin/nurse only)
    let departmentPerformance = [];
    if (['ADMIN', 'NURSE'].includes(req.user?.role)) {
      const deptResult = await db.query(`
        SELECT
          dept.id, dept.name,
          COUNT(f.id) as feedback_count,
          ROUND(AVG(f.rating), 2) as average_rating,
          ROUND(COUNT(*) FILTER (WHERE f.rating >= 4) * 100.0 / COUNT(*), 1) as positive_percentage
        FROM departments dept
        LEFT JOIN feedback f ON dept.id = f.department_id
        WHERE f.created_at > NOW() - INTERVAL '30 days'
        GROUP BY dept.id, dept.name
        HAVING COUNT(f.id) > 0
        ORDER BY average_rating DESC
      `);
      departmentPerformance = deptResult.rows;
    }

    // Satisfaction trends
    const satisfactionTrends = await db.query(`
      SELECT
        DATE_TRUNC('${groupBy}', created_at) as period,
        ROUND(AVG(rating), 2) as avg_rating,
        COUNT(*) as feedback_count,
        ROUND(COUNT(*) FILTER (WHERE rating >= 4) * 100.0 / COUNT(*), 1) as satisfaction_percentage
      FROM feedback
      WHERE created_at > NOW() - INTERVAL '90 days'
      ${req.user?.role === 'DOCTOR' ? `AND doctor_id = ${req.user.id}` : ''}
      GROUP BY DATE_TRUNC('${groupBy}', created_at)
      ORDER BY period DESC
    `);

    success(res, {
      doctorRankings: doctorRankings.rows,
      departmentPerformance,
      satisfactionTrends: satisfactionTrends.rows,
      requestedBy: req.user?.name,
      analysisDate: new Date().toISOString()
    }, 'Feedback analytics generated successfully');

  } catch (err) {
    logger.error('Feedback Analytics Error:', err);
    error(res, 'Failed to generate analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// 📊 Comprehensive Feedback Report (Admin only)
export async function getFeedbackReport(req, res) {
  try {
    // Role-based access control
    if (req.user?.role !== 'ADMIN') {
      return error(res, 'Admin access required for feedback reports', HTTP_STATUS.FORBIDDEN);
    }

    const { format = 'json', startDate, endDate } = req.query;

    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
      dateFilter = 'WHERE created_at BETWEEN $1 AND $2';
      params.push(startDate, endDate);
    }

    // Generate comprehensive report
    const report = await db.query(`
      SELECT
        COUNT(*) as total_feedback,
        ROUND(AVG(rating), 2) as overall_rating,
        COUNT(*) FILTER (WHERE rating = 5) as five_star,
        COUNT(*) FILTER (WHERE rating = 4) as four_star,
        COUNT(*) FILTER (WHERE rating = 3) as three_star,
        COUNT(*) FILTER (WHERE rating = 2) as two_star,
        COUNT(*) FILTER (WHERE rating = 1) as one_star,
        COUNT(DISTINCT phone) as unique_users,
        COUNT(*) FILTER (WHERE response_status = 'responded') as responded_count
      FROM feedback
      ${dateFilter}
    `, params);

    if (format === 'csv') {
      const data = report.rows[0];
      let csv = 'Metric,Value\n';
      Object.entries(data).forEach(([key, value]) => {
        csv += `${key},${value}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=feedback_report.csv');
      return res.send(csv);
    }

    success(res, {
      reportData: report.rows[0],
      reportPeriod: { startDate, endDate },
      requestedBy: req.user?.name,
      generatedAt: new Date().toISOString()
    }, 'Feedback report generated successfully');

  } catch (err) {
    logger.error('Feedback Report Error:', err);
    error(res, 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// 📝 Submit Feedback (Enhanced from deprecated version)
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
    const userCheck = await db.query(
      'SELECT uid, name FROM users WHERE phone = $1',
      [phone]
    );

    if (userCheck.rows.length === 0) {
      return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
    }

    const user = userCheck.rows[0];

    // Insert feedback
    const result = await db.query(
      `INSERT INTO feedback (
        phone, user_uid, rating, comment, category,
        appointment_id, doctor_id, department_id,
        anonymous, improvement_suggestions, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *`,
      [
        phone, user.uid, rating, comment, category,
        appointment_id, doctor_id, department_id,
        anonymous, improvement_suggestions
      ]
    );

    const feedback = result.rows[0];

    // Send notification to relevant staff if feedback is critical (rating <= 2)
    if (rating <= 2) {
      try {
        await db.query(
          `INSERT INTO notifications (
            recipient_role, title, body, type, priority, created_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            'ADMIN',
            'Critical Feedback Alert',
            `Poor rating (${rating}/5) received from patient. Category: ${category}`,
            'feedback_alert',
            'high'
          ]
        );
      } catch (notifErr) {
        logger.warn('Failed to send critical feedback notification:', notifErr.message);
      }
    }

    logger.info(`📝 Feedback submitted: ${phone} rated ${rating}/5 (${category}) by ${req.user?.name || 'system'}`);

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

// 👍 Quick Rating (Simple 1-5 star rating)
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

    const result = await db.query(
      `INSERT INTO feedback (
        phone, rating, category, appointment_id, created_at
      ) VALUES ($1, $2, $3, $4, NOW())
      RETURNING id, rating, created_at`,
      [normalizedPhone, rating, category, appointment_id]
    );

    logger.info(`👍 Quick rating submitted: ${normalizedPhone} rated ${rating}/5 by ${req.user?.name || 'system'}`);

    success(res, {
      ...result.rows[0],
      submittedBy: req.user?.name
    }, 'Quick rating submitted successfully');

  } catch (err) {
    logger.error('Quick Rating Error:', err);
    error(res, 'Failed to submit rating', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// 💬 Respond to Feedback (Staff access)
export async function respondToFeedback(req, res) {
  try {
    // Role-based access control
    if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
      return error(res, 'Staff access required to respond to feedback', HTTP_STATUS.FORBIDDEN);
    }

    const { feedback_id, response } = req.body;
    const staff_uid = req.user?.uid;

    if (!feedback_id || !response) {
      return error(res, 'Feedback ID and response are required', HTTP_STATUS.BAD_REQUEST);
    }

    // Check if feedback exists and if doctor can respond to their own feedback
    const feedbackCheck = await db.query(
      'SELECT id, phone, rating, doctor_id FROM feedback WHERE id = $1',
      [feedback_id]
    );

    if (feedbackCheck.rows.length === 0) {
      return error(res, 'Feedback not found', HTTP_STATUS.NOT_FOUND);
    }

    const feedback = feedbackCheck.rows[0];

    // Doctors can only respond to their own feedback
    if (req.user?.role === 'DOCTOR' && feedback.doctor_id !== req.user.id) {
      return error(res, 'Can only respond to feedback about yourself', HTTP_STATUS.FORBIDDEN);
    }

    // Insert response
    const result = await db.query(
      `INSERT INTO feedback_responses (
        feedback_id, responder_uid, response_text, created_at
      ) VALUES ($1, $2, $3, NOW())
      RETURNING *`,
      [feedback_id, staff_uid, response]
    );

    // Mark feedback as responded
    await db.query(
      'UPDATE feedback SET responded_at = NOW(), response_status = $1 WHERE id = $2',
      ['responded', feedback_id]
    );

    logger.info(`💬 Staff ${req.user?.name} responded to feedback ID: ${feedback_id}`);

    success(res, {
      response: result.rows[0],
      respondedBy: req.user?.name
    }, 'Response submitted successfully');

  } catch (err) {
    logger.error('Feedback Response Error:', err);
    error(res, 'Failed to submit response', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// 🗑️ Delete Inappropriate Feedback (Admin only)
export async function deleteFeedback(req, res) {
  try {
    const { feedback_id } = req.params;
    const { reason = 'Admin deletion' } = req.body;

    // Role-based access control
    if (req.user?.role !== 'ADMIN') {
      return error(res, 'Admin access required to delete feedback', HTTP_STATUS.FORBIDDEN);
    }

    const result = await db.query(
      'DELETE FROM feedback WHERE id = $1 RETURNING *',
      [feedback_id]
    );

    if (result.rows.length === 0) {
      return error(res, 'Feedback not found', HTTP_STATUS.NOT_FOUND);
    }

    // Log the deletion
    try {
      await db.query(
        `INSERT INTO admin_actions (
          admin_uid, action_type, target_type, target_id, reason, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [req.user?.uid, 'delete', 'feedback', feedback_id, reason]
      );
    } catch (logErr) {
      logger.warn('Failed to log admin action:', logErr.message);
    }

    logger.info(`🗑️ Admin ${req.user?.name} deleted feedback ID: ${feedback_id} - Reason: ${reason}`);

    success(res, {
      deletedFeedback: result.rows[0],
      reason,
      deletedBy: req.user?.name
    }, 'Feedback deleted successfully');

  } catch (err) {
    logger.error('Delete Feedback Error:', err);
    error(res, 'Failed to delete feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
