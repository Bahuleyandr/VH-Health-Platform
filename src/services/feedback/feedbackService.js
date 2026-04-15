// src/services/feedback/feedbackService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

class FeedbackService {
  /**
   * Get feedback history for a phone number.
   * Extracted from getMyFeedback controller.
   */
  async getFeedbackByPhone(phone) {
    const result = await prisma.$queryRawUnsafe(
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
      phone
    );

    const averageRating = this.calculateAverageRating(result);

    return {
      feedback: Array.isArray(result) ? result : [],
      totalCount: Array.isArray(result) ? result.length : 0,
      averageRating
    };
  }

  /**
   * Get feedback statistics for a phone number.
   * Extracted from getMyStats controller.
   */
  async getFeedbackStats(phone) {
    const result = await prisma.$queryRawUnsafe(
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
      phone
    );

    return result[0];
  }

  /**
   * Get feedback dashboard data for a given interval.
   * Extracted from getFeedbackDashboard controller.
   *
   * @param {string} interval - One of '7 days', '30 days', '90 days' (must be pre-validated/whitelisted by caller)
   */
  async getDashboard(interval) {
    // Overall statistics
    // Safety: `interval` must be whitelisted by the caller (only '7 days', '30 days', '90 days').
    // PostgreSQL does not support parameterized INTERVAL literals directly.
    const overallStats = await prisma.$queryRawUnsafe(`
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
    const categoryStats = await prisma.$queryRawUnsafe(`
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
    const dailyTrend = await prisma.$queryRawUnsafe(`
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

    return {
      overallStats: overallStats[0],
      categoryBreakdown: Array.isArray(categoryStats) ? categoryStats : [],
      dailyTrend: Array.isArray(dailyTrend) ? dailyTrend : []
    };
  }

  /**
   * Get recent feedback with filtering and pagination.
   * Extracted from getRecentFeedback controller.
   *
   * @param {object} filters - { page, limit, category, rating, priority, doctor_id, department_id }
   * @param {string} userRole - Role of the requesting user
   * @param {number|string} userId - DB id of the requesting user (used for DOCTOR scoping)
   */
  async getRecentFeedback(filters, userRole, userId) {
    const {
      page = 1, limit = 50, category, rating, priority = 'all',
      doctor_id, department_id
    } = filters;

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
    if (userRole === 'DOCTOR') {
      whereClause += ` AND f.doctor_id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    }

    const feedback = await prisma.$queryRawUnsafe(
      `
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
    `,
      ...params,
    );

    const total = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM feedback f ${whereClause}`,
      ...params.slice(2)
    );

    return {
      feedback: Array.isArray(feedback) ? feedback : [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total[0].count),
        totalPages: Math.ceil(total[0].count / limit)
      }
    };
  }

  /**
   * Get feedback analytics (doctor rankings, department performance, trends).
   * Extracted from getFeedbackAnalytics controller.
   *
   * @param {string} userRole - Role of the requesting user
   * @param {number|string} userId - DB id of the requesting user
   * @param {string} groupBy - Time grouping for trends (hour/day/week/month)
   */
  async getAnalytics(userRole, userId, groupBy = 'day') {
    // Doctor performance rankings
    const doctorParams = [];
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
    if (userRole === 'DOCTOR') {
      doctorParams.push(userId);
      doctorQuery += ` AND d.id = $${doctorParams.length}`;
    }

    doctorQuery += `
      GROUP BY d.id, d.name
      HAVING COUNT(f.id) > 0
      ORDER BY average_rating DESC, feedback_count DESC
    `;

    const doctorRankings = await prisma.$queryRawUnsafe(doctorQuery, ...doctorParams);

    // Department performance (admin/nurse only)
    let departmentPerformance = [];
    if (['ADMIN', 'NURSE'].includes(userRole)) {
      const deptResult = await prisma.$queryRawUnsafe(`
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
      departmentPerformance = deptResult;
    }

    // Satisfaction trends - whitelist groupBy to prevent SQL injection
    const allowedGroupBy = ['hour', 'day', 'week', 'month'];
    const safeGroupBy = allowedGroupBy.includes(groupBy) ? groupBy : 'day';

    const trendParams = [];
    let trendDoctorFilter = '';
    if (userRole === 'DOCTOR') {
      trendParams.push(userId);
      trendDoctorFilter = `AND doctor_id = $${trendParams.length}`;
    }

    // Safety: `safeGroupBy` is whitelisted above, so interpolation is safe
    const satisfactionTrends = await prisma.$queryRawUnsafe(
      `
      SELECT
        DATE_TRUNC('${safeGroupBy}', created_at) as period,
        ROUND(AVG(rating), 2) as avg_rating,
        COUNT(*) as feedback_count,
        ROUND(COUNT(*) FILTER (WHERE rating >= 4) * 100.0 / COUNT(*), 1) as satisfaction_percentage
      FROM feedback
      WHERE created_at > NOW() - INTERVAL '90 days'
      ${trendDoctorFilter}
      GROUP BY DATE_TRUNC('${safeGroupBy}', created_at)
      ORDER BY period DESC
    `,
      ...trendParams,
    );

    return {
      doctorRankings: doctorRankings,
      departmentPerformance,
      satisfactionTrends: satisfactionTrends
    };
  }

  /**
   * Generate a comprehensive feedback report.
   * Extracted from getFeedbackReport controller.
   *
   * @param {object} params - { startDate, endDate }
   */
  async getReport(params) {
    const { startDate, endDate } = params;

    let dateFilter = '';
    const queryParams = [];

    if (startDate && endDate) {
      dateFilter = 'WHERE created_at BETWEEN $1 AND $2';
      queryParams.push(startDate, endDate);
    }

    const result = await prisma.$queryRawUnsafe(
      `
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
    `,
      ...queryParams,
    );

    return result[0];
  }

  /**
   * Submit feedback (enhanced version with notifications).
   * Extracted from submitFeedbackEnhanced controller.
   */
  async submitFeedback(data) {
    const {
      phone, userUid, rating, comment, category,
      appointment_id, doctor_id, department_id,
      anonymous, improvement_suggestions
    } = data;

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO feedback (
        phone, user_uid, rating, comment, category,
        appointment_id, doctor_id, department_id,
        anonymous, improvement_suggestions, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id, uid, phone, type, comment, rating, status, created_at, updated_at`,
      phone,
      userUid,
      rating,
      comment,
      category,
      appointment_id,
      doctor_id,
      department_id,
      anonymous,
      improvement_suggestions,
    );

    const feedback = result[0];

    // Send notification to relevant staff if feedback is critical (rating <= 2)
    if (rating <= 2) {
      try {
        await prisma.$queryRawUnsafe(
          `INSERT INTO notifications (
            recipient_role, title, body, type, priority, created_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())`,
          'ADMIN',
          'Critical Feedback Alert',
          `Poor rating (${rating}/5) received from patient. Category: ${category}`,
          'feedback_alert',
          'high',
        );
      } catch (notifErr) {
        logger.warn('Failed to send critical feedback notification:', notifErr.message);
      }
    }

    return feedback;
  }

  /**
   * Submit a quick 1-5 star rating.
   * Extracted from submitQuickRating controller.
   */
  async submitQuickRating(data) {
    const { phone, rating, category, appointment_id } = data;

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO feedback (
        phone, rating, category, appointment_id, created_at
      ) VALUES ($1, $2, $3, $4, NOW())
      RETURNING id, rating, created_at`,
      phone,
      rating,
      category,
      appointment_id,
    );

    return result[0];
  }

  /**
   * Respond to feedback (staff action).
   * Extracted from respondToFeedback controller.
   */
  async respondToFeedback(feedbackId, staffUid, response) {
    // Insert response
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO feedback_responses (
        feedback_id, responder_uid, response_text, created_at
      ) VALUES ($1, $2, $3, NOW())
      RETURNING id, uid, phone, type, comment, rating, status, created_at, updated_at`,
      feedbackId,
      staffUid,
      response,
    );

    // Mark feedback as responded
    await prisma.$queryRawUnsafe(
      'UPDATE feedback SET responded_at = NOW(), response_status = $1 WHERE id = $2',
      'responded',
      feedbackId,
    );

    return result[0];
  }

  /**
   * Delete feedback and log admin action.
   * Extracted from deleteFeedback controller.
   */
  async deleteFeedback(feedbackId, adminUid, reason) {
    const result = await prisma.$queryRawUnsafe(
      'DELETE FROM feedback WHERE id = $1 RETURNING id, uid, phone, type, comment, rating, status, created_at, updated_at',
      feedbackId,
    );

    if (result.length === 0) {
      return null;
    }

    // Log the deletion
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO admin_actions (
          admin_uid, action_type, target_type, target_id, reason, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        adminUid,
        'delete',
        'feedback',
        feedbackId,
        reason,
      );
    } catch (logErr) {
      logger.warn('Failed to log admin action:', logErr.message);
    }

    return result[0];
  }

  /**
   * Look up a user by phone. Used for validation before submitting feedback.
   */
  async getUserByPhone(phone) {
    const result = await prisma.$queryRawUnsafe(
      'SELECT uid, name FROM users WHERE phone = $1',
      phone,
    );
    return result[0] || null;
  }

  /**
   * Look up feedback by ID. Used for permission checks before responding.
   */
  async getFeedbackById(feedbackId) {
    const result = await prisma.$queryRawUnsafe(
      'SELECT id, phone, rating, doctor_id FROM feedback WHERE id = $1',
      feedbackId,
    );
    return result[0] || null;
  }

  /**
   * Submit simple feedback (legacy endpoint with optional question field).
   * Used by the basic submitFeedback controller.
   */
  async submitSimpleFeedback(phone, rating, comment, question) {
    const result = await prisma.$queryRawUnsafe(
      'INSERT INTO feedback (phone, rating, comment, question) VALUES ($1, $2, $3, $4) RETURNING id, phone, rating, comment, question, created_at',
      phone,
      rating || null,
      comment || null,
      question || null,
    );
    return result[0];
  }

  /**
   * Calculate the average rating from an array of feedback rows.
   */
  calculateAverageRating(rows) {
    if (!rows.length) return null;
    return (rows.reduce((sum, f) => sum + (f.rating || 0), 0) / rows.length).toFixed(1);
  }
}

export default new FeedbackService();
