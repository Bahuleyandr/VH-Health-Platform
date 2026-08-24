// src/services/feedback/feedbackService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const FEEDBACK_TENANT_JOIN = "LEFT JOIN users fu ON (fu.uid = f.uid OR fu.phone = f.phone)";
const FEEDBACK_TENANT_EXPR = `COALESCE(fu.tenant_id, '${DEFAULT_TENANT_ID}'::uuid)`;

function shiftSqlParams(sql, delta) {
  return sql.replace(/\$(\d+)/g, (_match, number) => `$${Number(number) + delta}`);
}

class FeedbackService {
  /**
   * Get feedback history for a phone number.
   * Extracted from getMyFeedback controller.
   */
  async getFeedbackByPhone(phone, tenantId = DEFAULT_TENANT_ID) {
    const result = await prisma.$queryRawUnsafe(
      `SELECT
        f.id, f.rating, f.comment, f.category, f.created_at,
        f.is_anonymous AS anonymous, NULL::text AS improvement_suggestions, f.response_status,
        f.responded_at,
        d.name as doctor_name,
        dept.name as department_name,
        a.appointment_date as appointment_date
       FROM feedback f
       ${FEEDBACK_TENANT_JOIN}
       LEFT JOIN doctors d ON f.doctor_id = d.id
       LEFT JOIN departments dept ON f.department_id = dept.id
       LEFT JOIN appointments a ON f.appointment_id = a.id
       WHERE f.phone = $1
         AND ${FEEDBACK_TENANT_EXPR} = $2::uuid
       ORDER BY f.created_at DESC`,
      phone,
      tenantId,
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
  async getFeedbackStats(phone, tenantId = DEFAULT_TENANT_ID) {
    const result = await prisma.$queryRawUnsafe(
      `SELECT
        COUNT(*)::int as total_feedback,
        ROUND(AVG(rating), 2) as average_rating,
        COUNT(*) FILTER (WHERE rating >= 4)::int as positive_feedback,
        COUNT(*) FILTER (WHERE rating <= 2)::int as negative_feedback,
        COUNT(*) FILTER (WHERE rating = 3)::int as neutral_feedback,
        array_agg(DISTINCT category) as categories_used,
        MIN(created_at) as first_feedback,
        MAX(created_at) as latest_feedback,
         COUNT(*) FILTER (WHERE response_status = 'responded')::int as responded_count
       FROM feedback f
       ${FEEDBACK_TENANT_JOIN}
       WHERE f.phone = $1
         AND ${FEEDBACK_TENANT_EXPR} = $2::uuid`,
      phone,
      tenantId,
    );

    return result[0];
  }

  /**
   * Get feedback dashboard data for a given interval.
   * Extracted from getFeedbackDashboard controller.
   *
   * @param {string} interval - One of '7 days', '30 days', '90 days' (must be pre-validated/whitelisted by caller)
   */
  async getDashboard(interval, tenantId = DEFAULT_TENANT_ID) {
    // Overall statistics
    // Safety: `interval` must be whitelisted by the caller (only '7 days', '30 days', '90 days').
    // PostgreSQL does not support parameterized INTERVAL literals directly.
    const overallStats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) as total_feedback,
        ROUND(AVG(rating), 2) as average_rating,
        COUNT(*) FILTER (WHERE rating >= 4) as positive_count,
        COUNT(*) FILTER (WHERE rating <= 2) as negative_count,
        COUNT(DISTINCT f.phone) as unique_users,
        COUNT(*) FILTER (WHERE response_status = 'responded') as responded_count
      FROM feedback f
      ${FEEDBACK_TENANT_JOIN}
      WHERE ${FEEDBACK_TENANT_EXPR} = $1::uuid
        AND f.created_at > NOW() - INTERVAL '${interval}'
    `, tenantId);

    // Feedback by category
    const categoryStats = await prisma.$queryRawUnsafe(`
      SELECT
        category,
        COUNT(*) as count,
        ROUND(AVG(rating), 2) as avg_rating
      FROM feedback f
      ${FEEDBACK_TENANT_JOIN}
      WHERE ${FEEDBACK_TENANT_EXPR} = $1::uuid
        AND f.created_at > NOW() - INTERVAL '${interval}'
      GROUP BY f.category
      ORDER BY count DESC
    `, tenantId);

    // Daily trend
    const dailyTrend = await prisma.$queryRawUnsafe(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as feedback_count,
        ROUND(AVG(rating), 2) as avg_rating
      FROM feedback f
      ${FEEDBACK_TENANT_JOIN}
      WHERE ${FEEDBACK_TENANT_EXPR} = $1::uuid
        AND f.created_at > NOW() - INTERVAL '${interval}'
      GROUP BY DATE(f.created_at)
      ORDER BY date DESC
      LIMIT 30
    `, tenantId);

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
  async getRecentFeedback(filters, userRole, userId, tenantId = DEFAULT_TENANT_ID) {
    const {
      category, rating, priority = 'all',
      doctor_id, department_id
    } = filters;

    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });
    let whereClause = 'WHERE 1=1';
    const params = [listQuery.limit, listQuery.offset, tenantId];
    let paramIndex = 4;

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
        f.is_anonymous AS anonymous, NULL::text AS improvement_suggestions, f.response_status,
        u.name as user_name,
        d.name as doctor_name,
        dept.name as department_name,
        CASE
          WHEN f.rating <= 2 THEN 'critical'
          WHEN f.rating >= 4 THEN 'positive'
          ELSE 'neutral'
        END as priority_level
      FROM feedback f
      ${FEEDBACK_TENANT_JOIN}
      LEFT JOIN users u ON f.phone = u.phone
      LEFT JOIN doctors d ON f.doctor_id = d.id
      LEFT JOIN departments dept ON f.department_id = dept.id
      ${whereClause} AND ${FEEDBACK_TENANT_EXPR} = $3::uuid
      ORDER BY f.created_at DESC
      LIMIT $1 OFFSET $2
    `,
      ...params,
    );

    const totalWhereClause = shiftSqlParams(whereClause, -2);
    const total = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)
         FROM feedback f
         ${FEEDBACK_TENANT_JOIN}
        ${totalWhereClause} AND ${FEEDBACK_TENANT_EXPR} = $1::uuid`,
      tenantId,
      ...params.slice(3),
    );
    const totalCount = Number(total[0]?.count || 0);

    return {
      feedback: Array.isArray(feedback) ? feedback : [],
      pagination: buildPagination(totalCount, listQuery.page, listQuery.limit)
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
  async getAnalytics(userRole, userId, groupBy = 'day', tenantId = DEFAULT_TENANT_ID) {
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
      ${FEEDBACK_TENANT_JOIN}
      WHERE ${FEEDBACK_TENANT_EXPR} = $1::uuid
        AND f.created_at > NOW() - INTERVAL '30 days'
    `;
    doctorParams.push(tenantId);

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
        ${FEEDBACK_TENANT_JOIN}
        WHERE ${FEEDBACK_TENANT_EXPR} = $1::uuid
          AND f.created_at > NOW() - INTERVAL '30 days'
        GROUP BY dept.id, dept.name
        HAVING COUNT(f.id) > 0
        ORDER BY average_rating DESC
      `, tenantId);
      departmentPerformance = deptResult;
    }

    // Satisfaction trends - whitelist groupBy to prevent SQL injection
    const allowedGroupBy = ['hour', 'day', 'week', 'month'];
    const safeGroupBy = allowedGroupBy.includes(groupBy) ? groupBy : 'day';

    const trendParams = [tenantId];
    let trendDoctorFilter = '';
    if (userRole === 'DOCTOR') {
      trendParams.push(userId);
      trendDoctorFilter = `AND f.doctor_id = $${trendParams.length}`;
    }

    // Safety: `safeGroupBy` is whitelisted above, so interpolation is safe
    const satisfactionTrends = await prisma.$queryRawUnsafe(
      `
      SELECT
        DATE_TRUNC('${safeGroupBy}', f.created_at) as period,
        ROUND(AVG(rating), 2) as avg_rating,
        COUNT(*) as feedback_count,
        ROUND(COUNT(*) FILTER (WHERE rating >= 4) * 100.0 / COUNT(*), 1) as satisfaction_percentage
      FROM feedback f
      ${FEEDBACK_TENANT_JOIN}
      WHERE ${FEEDBACK_TENANT_EXPR} = $1::uuid
      AND f.created_at > NOW() - INTERVAL '90 days'
      ${trendDoctorFilter}
      GROUP BY DATE_TRUNC('${safeGroupBy}', f.created_at)
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
  async getReport(params, tenantId = DEFAULT_TENANT_ID) {
    const { startDate, endDate } = params;

    let dateFilter = `WHERE ${FEEDBACK_TENANT_EXPR} = $1::uuid`;
    const queryParams = [tenantId];

    if (startDate && endDate) {
      dateFilter += ' AND f.created_at BETWEEN $2 AND $3';
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
        COUNT(DISTINCT f.phone) as unique_users,
        COUNT(*) FILTER (WHERE response_status = 'responded') as responded_count
      FROM feedback f
      ${FEEDBACK_TENANT_JOIN}
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
      anonymous, improvement_suggestions,
      tenantId = DEFAULT_TENANT_ID,
    } = data;
    const combinedComment = [comment, improvement_suggestions && `Improvement suggestions: ${improvement_suggestions}`]
      .filter(Boolean)
      .join('\n\n') || null;

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO feedback (
        phone, uid, rating, comment, category,
        appointment_id, doctor_id, department_id,
        is_anonymous, created_at, updated_at
      ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      RETURNING id, uid, phone, comment, rating, category, status, is_anonymous AS anonymous, created_at, updated_at`,
      phone,
      userUid,
      rating,
      combinedComment,
      category,
      appointment_id,
      doctor_id,
      department_id,
      Boolean(anonymous),
    );

    const feedback = result[0];

    // Send notification to relevant staff if feedback is critical (rating <= 2)
    if (rating <= 2) {
      try {
        await prisma.$queryRawUnsafe(
          // tenant_id bound explicitly ($6) rather than left to the column
          // DEFAULT, which reads app.current_tenant_id and falls back to the
          // literal default tenant whenever that GUC is unset — the alert would
          // otherwise be filed against the wrong tenant entirely.
          // NOTE (pre-existing, NOT fixed here): `notifications.phone` is
          // NOT NULL with no default, so this statement still raises 23502 and
          // is swallowed by the catch below; and no read path in the backend
          // selects on `recipient_role`, so a role-targeted row has no reader
          // even once it lands. Both are reported as separate findings.
          `INSERT INTO notifications (
            recipient_role, title, body, type, priority, created_at, tenant_id
          ) VALUES ($1, $2, $3, $4, $5, NOW(), $6::uuid)`,
          'ADMIN',
          'Critical Feedback Alert',
          `Poor rating (${rating}/5) received from patient. Category: ${category}`,
          'feedback_alert',
          'high',
          tenantId,
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
    const { phone, uid, rating, category, appointment_id } = data;

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO feedback (
        uid, phone, rating, category, appointment_id, created_at, updated_at
      ) VALUES ($1::uuid, $2, $3, $4, $5, NOW(), NOW())
      RETURNING id, uid, phone, rating, category, created_at, updated_at`,
      uid,
      phone,
      rating,
      category,
      appointment_id,
    );

    return result[0];
  }

  // REMOVED (re-audit I, tenancy sweep): `respondToFeedback` + its
  // `getFeedbackById` permission-check helper.
  //
  // The method INSERTed into `feedback_responses`, a table that exists in no
  // migration, is absent from `000_baseline.sql`, and has no Prisma model —
  // verified by applying every published migration to a clean database and
  // finding `to_regclass('public.feedback_responses')` NULL. The
  // "migration 023" reference in docs/DB-SCHEMA-REFERENCE.md was stale
  // (023 is prior-authorization automation). Every call therefore raised
  // 42P01 and surfaced as a generic 500, so the staff answer to an
  // Ask-a-Doubt question was never stored and the follow-up
  // `UPDATE feedback SET response_status = 'responded'` never ran — which is
  // also why `responded_count` on the feedback dashboard/report has always
  // been 0. Removing the endpoint changes neither fact.
  //
  // The INSERT's own RETURNING list (`id, uid, phone, type, comment, rating,
  // status, ...`) names `feedback` columns, not columns of a responses table,
  // so the statement could never have executed against any schema.
  //
  // No read side existed anywhere — not in this service, not in any
  // controller, not in the admin portal, not in either Flutter app — so
  // creating the table would have persisted patient-visible answers that no
  // surface renders. Do NOT reintroduce this path; build staff follow-up on
  // the NPS / service-recovery surface (`npsService.submitNpsResponse`),
  // which is wired end to end.

  /**
   * Delete feedback and log admin action.
   * Extracted from deleteFeedback controller.
   */
  async deleteFeedback(feedbackId, adminUid, reason, tenantId = DEFAULT_TENANT_ID) {
    const result = await prisma.$queryRawUnsafe(
      `DELETE FROM feedback f
       WHERE f.id = $1
         AND EXISTS (
           SELECT 1 FROM users fu
            WHERE (fu.uid = f.uid OR fu.phone = f.phone)
              AND COALESCE(fu.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $2::uuid
         )
       RETURNING f.id, f.uid, f.phone, NULL::text AS type, f.comment, f.rating, f.status, f.created_at, f.updated_at`,
      feedbackId,
      tenantId,
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
  async getUserByPhone(phone, tenantId = DEFAULT_TENANT_ID) {
    const result = await prisma.$queryRawUnsafe(
      'SELECT uid, name FROM users WHERE phone = $1 AND tenant_id = $2::uuid',
      phone,
      tenantId,
    );
    return result[0] || null;
  }

  /**
   * Submit simple feedback (legacy endpoint with optional question field).
   * Used by the basic submitFeedback controller.
   */
  async submitSimpleFeedback(phone, rating, comment, question) {
    const normalizedRating = Number.isInteger(Number(rating)) ? Number(rating) : 3;
    const category = question && !comment ? 'QUESTION' : 'GENERAL';
    const combinedComment = [comment, question && `Question: ${question}`]
      .filter(Boolean)
      .join('\n\n') || null;

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO feedback (phone, rating, comment, category, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, phone, rating, comment, NULL::text AS question, category, created_at, updated_at`,
      phone,
      Math.min(Math.max(normalizedRating, 1), 5),
      combinedComment,
      category,
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
