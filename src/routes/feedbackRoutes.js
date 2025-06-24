// src/routes/feedbackRoutes.js - Enhanced Patient Feedback System

import express from 'express';
import { validationResult } from 'express-validator';
import * as feedbackController from '../controllers/feedbackController.js';
import { feedbackValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

// ✅ Patient Feedback Routes
wrapAutoRBAC(router, 'feedbackRoutes', {
  post: [
    // 📝 Submit Feedback
    [
      '/',
      feedbackValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
        const { 
          rating, comment, category = 'general', 
          appointmentId, doctorId, departmentId,
          anonymous = false, improvementSuggestions 
        } = req.body;

        try {
          // Check if user exists
          const userCheck = await pool.query(
            'SELECT uid, name FROM users WHERE phone = $1',
            [phone]
          );

          if (userCheck.rows.length === 0) {
            return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
          }

          const user = userCheck.rows[0];

          // Insert feedback
          const result = await pool.query(
            `INSERT INTO feedback (
              phone, user_uid, rating, comment, category,
              appointment_id, doctor_id, department_id,
              anonymous, improvement_suggestions, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()) 
            RETURNING *`,
            [
              phone, user.uid, rating, comment, category,
              appointmentId, doctorId, departmentId,
              anonymous, improvementSuggestions
            ]
          );

          const feedback = result.rows[0];

          // Send notification to relevant staff if feedback is critical (rating <= 2)
          if (rating <= 2) {
            await pool.query(
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
          }

          // Update doctor/department feedback stats if specified
          if (doctorId) {
            await pool.query(
              `UPDATE doctors SET 
                total_feedback_count = total_feedback_count + 1,
                average_rating = (
                  SELECT AVG(rating) FROM feedback WHERE doctor_id = $1
                ),
                last_feedback_at = NOW()
               WHERE id = $1`,
              [doctorId]
            );
          }

          if (departmentId) {
            await pool.query(
              `UPDATE departments SET 
                total_feedback_count = total_feedback_count + 1,
                average_rating = (
                  SELECT AVG(rating) FROM feedback WHERE department_id = $1
                ),
                last_feedback_at = NOW()
               WHERE id = $1`,
              [departmentId]
            );
          }

          logger.info(`📝 Feedback submitted: ${phone} rated ${rating}/5 (${category})`);

          success(res, {
            feedbackId: feedback.id,
            rating: feedback.rating,
            category: feedback.category,
            submittedAt: feedback.created_at,
            anonymous: feedback.anonymous
          }, RESPONSE_MESSAGES.FEEDBACK_SUBMITTED);

        } catch (err) {
          logger.error('Submit Feedback Error:', err.stack || err.toString());
          error(res, 'Failed to submit feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 👍 Quick Rating (Simple 1-5 star rating)
    [
      '/quick-rating',
      async (req, res) => {
        const { phone, rating, appointmentId, category = 'quick' } = req.body;

        if (!phone || !rating || rating < 1 || rating > 5) {
          return error(res, 'Valid phone and rating (1-5) required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const normalizedPhone = normalizePhone(phone);

          const result = await pool.query(
            `INSERT INTO feedback (
              phone, rating, category, appointment_id, created_at
            ) VALUES ($1, $2, $3, $4, NOW()) 
            RETURNING id, rating, created_at`,
            [normalizedPhone, rating, category, appointmentId]
          );

          success(res, result.rows[0], 'Quick rating submitted');

        } catch (err) {
          logger.error('Quick Rating Error:', err);
          error(res, 'Failed to submit rating', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    // 📋 Get User's Feedback History
    [
      '/my-feedback',
      async (req, res) => {
        const phone = normalizePhone(req.user?.phone || req.query.phone);
        
        if (!phone) {
          return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const result = await pool.query(
            `SELECT 
              f.id, f.rating, f.comment, f.category, f.created_at,
              f.anonymous, f.improvement_suggestions,
              d.name as doctor_name,
              dept.name as department_name,
              a.date as appointment_date
             FROM feedback f
             LEFT JOIN doctors d ON f.doctor_id = d.id
             LEFT JOIN departments dept ON f.department_id = dept.id
             LEFT JOIN appointments a ON f.appointment_id = a.id
             WHERE f.phone = $1
             ORDER BY f.created_at DESC`,
            [phone]
          );

          success(res, {
            feedback: result.rows,
            totalCount: result.rows.length,
            averageRating: result.rows.length > 0 
              ? (result.rows.reduce((sum, f) => sum + f.rating, 0) / result.rows.length).toFixed(1)
              : null
          }, 'Feedback history retrieved');

        } catch (err) {
          logger.error('Get Feedback Error:', err);
          error(res, 'Failed to fetch feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Feedback Statistics for User
    [
      '/my-stats',
      async (req, res) => {
        const phone = normalizePhone(req.user?.phone || req.query.phone);

        try {
          const stats = await pool.query(
            `SELECT 
              COUNT(*) as total_feedback,
              AVG(rating) as average_rating,
              COUNT(*) FILTER (WHERE rating >= 4) as positive_feedback,
              COUNT(*) FILTER (WHERE rating <= 2) as negative_feedback,
              array_agg(DISTINCT category) as categories_used,
              MIN(created_at) as first_feedback,
              MAX(created_at) as latest_feedback
             FROM feedback 
             WHERE phone = $1`,
            [phone]
          );

          success(res, stats.rows[0], 'Feedback statistics retrieved');

        } catch (err) {
          logger.error('Feedback Stats Error:', err);
          error(res, 'Failed to fetch statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📋 Get Feedback by UID (Utility route)
    ['/uid/:uid', feedbackController.getFeedbackByUID]
  ]
});

// ✅ Staff Routes for Feedback Management
wrapRoutes(
  router,
  ['ADMIN', 'DOCTOR', 'NURSING_STAFF', 'GENERAL_STAFF'], // Staff access
  {
    get: [
      // 📊 Feedback Dashboard
      [
        '/staff/dashboard',
        async (req, res) => {
          try {
            const { timeframe = '30d' } = req.query;
            
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              default: interval = '30 days';
            }

            // Overall statistics
            const overallStats = await pool.query(`
              SELECT 
                COUNT(*) as total_feedback,
                AVG(rating) as average_rating,
                COUNT(*) FILTER (WHERE rating >= 4) as positive_count,
                COUNT(*) FILTER (WHERE rating <= 2) as negative_count,
                COUNT(DISTINCT phone) as unique_users
              FROM feedback 
              WHERE created_at > NOW() - INTERVAL '${interval}'
            `);

            // Feedback by category
            const categoryStats = await pool.query(`
              SELECT 
                category,
                COUNT(*) as count,
                AVG(rating) as avg_rating
              FROM feedback 
              WHERE created_at > NOW() - INTERVAL '${interval}'
              GROUP BY category
              ORDER BY count DESC
            `);

            // Daily trend
            const dailyTrend = await pool.query(`
              SELECT 
                DATE(created_at) as date,
                COUNT(*) as feedback_count,
                AVG(rating) as avg_rating
              FROM feedback 
              WHERE created_at > NOW() - INTERVAL '${interval}'
              GROUP BY DATE(created_at)
              ORDER BY date DESC
            `);

            // Top concerns (from improvement suggestions)
            const topConcerns = await pool.query(`
              SELECT 
                improvement_suggestions,
                COUNT(*) as frequency
              FROM feedback 
              WHERE created_at > NOW() - INTERVAL '${interval}'
                AND improvement_suggestions IS NOT NULL
                AND improvement_suggestions != ''
              GROUP BY improvement_suggestions
              ORDER BY frequency DESC
              LIMIT 10
            `);

            success(res, {
              timeframe,
              overallStats: overallStats.rows[0],
              categoryBreakdown: categoryStats.rows,
              dailyTrend: dailyTrend.rows,
              topConcerns: topConcerns.rows,
              generatedAt: new Date().toISOString()
            }, 'Feedback dashboard data retrieved');

          } catch (err) {
            logger.error('Feedback Dashboard Error:', err);
            error(res, 'Failed to fetch dashboard data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📋 Recent Feedback with Filtering
      [
        '/staff/recent',
        async (req, res) => {
          try {
            const { 
              page = 1, limit = 50, category, rating, priority = 'all',
              doctorId, departmentId 
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

            if (doctorId) {
              whereClause += ` AND f.doctor_id = $${paramIndex}`;
              params.push(doctorId);
              paramIndex++;
            }

            if (departmentId) {
              whereClause += ` AND f.department_id = $${paramIndex}`;
              params.push(departmentId);
              paramIndex++;
            }

            const feedback = await pool.query(`
              SELECT 
                f.id, f.phone, f.rating, f.comment, f.category, f.created_at,
                f.anonymous, f.improvement_suggestions,
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

            const total = await pool.query(
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
              filters: { category, rating, priority, doctorId, departmentId }
            }, 'Recent feedback retrieved');

          } catch (err) {
            logger.error('Recent Feedback Error:', err);
            error(res, 'Failed to fetch recent feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📈 Feedback Analytics
      [
        '/staff/analytics',
        async (req, res) => {
          try {
            const { startDate, endDate, groupBy = 'day' } = req.query;

            // Doctor performance rankings
            const doctorRankings = await pool.query(`
              SELECT 
                d.id, d.name,
                COUNT(f.id) as feedback_count,
                AVG(f.rating) as average_rating,
                COUNT(*) FILTER (WHERE f.rating >= 4) as positive_feedback,
                COUNT(*) FILTER (WHERE f.rating <= 2) as negative_feedback
              FROM doctors d
              LEFT JOIN feedback f ON d.id = f.doctor_id
              WHERE f.created_at > NOW() - INTERVAL '30 days'
              GROUP BY d.id, d.name
              HAVING COUNT(f.id) > 0
              ORDER BY average_rating DESC, feedback_count DESC
            `);

            // Department performance
            const departmentPerformance = await pool.query(`
              SELECT 
                dept.id, dept.name,
                COUNT(f.id) as feedback_count,
                AVG(f.rating) as average_rating,
                COUNT(*) FILTER (WHERE f.rating >= 4) as positive_percentage
              FROM departments dept
              LEFT JOIN feedback f ON dept.id = f.department_id
              WHERE f.created_at > NOW() - INTERVAL '30 days'
              GROUP BY dept.id, dept.name
              HAVING COUNT(f.id) > 0
              ORDER BY average_rating DESC
            `);

            // Satisfaction trends
            const satisfactionTrends = await pool.query(`
              SELECT 
                DATE_TRUNC('${groupBy}', created_at) as period,
                AVG(rating) as avg_rating,
                COUNT(*) as feedback_count,
                COUNT(*) FILTER (WHERE rating >= 4) * 100.0 / COUNT(*) as satisfaction_percentage
              FROM feedback 
              WHERE created_at > NOW() - INTERVAL '90 days'
              GROUP BY DATE_TRUNC('${groupBy}', created_at)
              ORDER BY period DESC
            `);

            success(res, {
              doctorRankings: doctorRankings.rows,
              departmentPerformance: departmentPerformance.rows,
              satisfactionTrends: satisfactionTrends.rows,
              analysisDate: new Date().toISOString()
            }, 'Feedback analytics generated');

          } catch (err) {
            logger.error('Feedback Analytics Error:', err);
            error(res, 'Failed to generate analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // 💬 Respond to Feedback
      [
        '/staff/respond',
        async (req, res) => {
          try {
            const { feedbackId, response, responderId } = req.body;
            const staffUid = req.user?.uid;

            if (!feedbackId || !response) {
              return error(res, 'Feedback ID and response are required', HTTP_STATUS.BAD_REQUEST);
            }

            // Check if feedback exists
            const feedbackCheck = await pool.query(
              'SELECT id, phone, rating FROM feedback WHERE id = $1',
              [feedbackId]
            );

            if (feedbackCheck.rows.length === 0) {
              return error(res, 'Feedback not found', HTTP_STATUS.NOT_FOUND);
            }

            // Insert response
            const result = await pool.query(
              `INSERT INTO feedback_responses (
                feedback_id, responder_uid, response_text, created_at
              ) VALUES ($1, $2, $3, NOW()) 
              RETURNING *`,
              [feedbackId, staffUid, response]
            );

            // Mark feedback as responded
            await pool.query(
              'UPDATE feedback SET responded_at = NOW(), response_status = $1 WHERE id = $2',
              ['responded', feedbackId]
            );

            // Send notification to user
            const feedback = feedbackCheck.rows[0];
            await pool.query(
              `INSERT INTO notifications (
                phone, title, body, type, created_at
              ) VALUES ($1, $2, $3, $4, NOW())`,
              [
                feedback.phone,
                'Response to Your Feedback',
                'We have responded to your recent feedback. Thank you for helping us improve!',
                'feedback_response'
              ]
            );

            logger.info(`💬 Staff responded to feedback ID: ${feedbackId}`);

            success(res, result.rows[0], 'Response submitted successfully');

          } catch (err) {
            logger.error('Feedback Response Error:', err);
            error(res, 'Failed to submit response', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// ✅ Admin Routes for Feedback Management
wrapRoutes(
  router,
  ['ADMIN'], // Admin only
  {
    get: [
      // 📊 Comprehensive Feedback Report
      [
        '/admin/report',
        async (req, res) => {
          try {
            const { format = 'json', startDate, endDate } = req.query;

            let dateFilter = '';
            const params = [];

            if (startDate && endDate) {
              dateFilter = 'WHERE created_at BETWEEN $1 AND $2';
              params.push(startDate, endDate);
            }

            // Generate comprehensive report
            const report = await pool.query(`
              SELECT 
                COUNT(*) as total_feedback,
                AVG(rating) as overall_rating,
                COUNT(*) FILTER (WHERE rating = 5) as five_star,
                COUNT(*) FILTER (WHERE rating = 4) as four_star,
                COUNT(*) FILTER (WHERE rating = 3) as three_star,
                COUNT(*) FILTER (WHERE rating = 2) as two_star,
                COUNT(*) FILTER (WHERE rating = 1) as one_star,
                COUNT(DISTINCT phone) as unique_users,
                COUNT(*) FILTER (WHERE responded_at IS NOT NULL) as responded_count
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
              generatedAt: new Date().toISOString()
            }, 'Feedback report generated');

          } catch (err) {
            logger.error('Feedback Report Error:', err);
            error(res, 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    delete: [
      // 🗑️ Delete Inappropriate Feedback
      [
        '/admin/delete/:feedbackId',
        async (req, res) => {
          try {
            const { feedbackId } = req.params;
            const { reason = 'Admin deletion' } = req.body;
            const adminUid = req.user?.uid;

            const result = await pool.query(
              'DELETE FROM feedback WHERE id = $1 RETURNING *',
              [feedbackId]
            );

            if (result.rows.length === 0) {
              return error(res, 'Feedback not found', HTTP_STATUS.NOT_FOUND);
            }

            // Log the deletion
            await pool.query(
              `INSERT INTO admin_actions (
                admin_uid, action_type, target_type, target_id, reason, created_at
              ) VALUES ($1, $2, $3, $4, $5, NOW())`,
              [adminUid, 'delete', 'feedback', feedbackId, reason]
            );

            logger.info(`🗑️ Admin deleted feedback ID: ${feedbackId} - Reason: ${reason}`);

            success(res, {
              deletedFeedback: result.rows[0],
              reason,
              deletedBy: adminUid
            }, 'Feedback deleted successfully');

          } catch (err) {
            logger.error('Delete Feedback Error:', err);
            error(res, 'Failed to delete feedback', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

export default router;