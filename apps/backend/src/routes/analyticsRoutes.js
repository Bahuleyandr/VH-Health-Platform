

// src/routes/analyticsRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import { HTTP_STATUS } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as analyticsController from '../controllers/analyticsController.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';

const router = express.Router();
logger.info('✅ analyticsRoutes loaded with RBAC protection');

function analyticsUnavailable(res, message) {
  return error(res, message, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

/**
 * ✅ Analytics routes with RBAC protection
 * Accessible to ADMIN and DOCTOR roles
 * Comprehensive analytics and reporting system
 */
wrapAutoRBAC(
  router,
  'analyticsRoutes',
  {
    get: [
      // 📊 Comprehensive Dashboard Analytics
      [
        '/dashboard',
        async (req, res) => {
          // ✅ FIX: 'timeframe' is now declared here, outside the try block.
          const { timeframe = '30d' } = req.query;
          
          try {
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              case '1y': interval = '1 year'; break;
              default: interval = '30 days';
            }

            // Parallel queries for comprehensive analytics
            const [
              userStats, appointmentStats, healthRecordStats, 
              investigationStats, pharmacyStats, feedbackStats, sosStats
            ] = await Promise.all([
              // User analytics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_users,
                  COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '${interval}') as new_users,
                  COUNT(*) FILTER (WHERE last_sign_in_at > NOW() - INTERVAL '7 days') as active_users_7d,
                  COUNT(*) FILTER (WHERE role = 'PATIENT') as patients,
                  COUNT(*) FILTER (WHERE role = 'DOCTOR') as doctors,
                  COUNT(*) FILTER (WHERE role IN ('NURSE', 'ADMIN', 'PHARMACIST')) as staff,
                  COUNT(DISTINCT CASE WHEN last_sign_in_at > NOW() - INTERVAL '24 hours' THEN id END) as daily_active_users
                FROM users
              `),
              
              // Appointment analytics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_appointments,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_appointments,
                  COUNT(*) FILTER (WHERE appointment_date >= CURRENT_DATE) as upcoming_appointments,
                  COUNT(*) FILTER (WHERE appointment_date < CURRENT_DATE AND status = 'COMPLETED') as completed_appointments,
                  COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_appointments,
                  COUNT(DISTINCT patient_id) as unique_patients,
                  AVG(CASE WHEN status = 'COMPLETED' THEN 1.0 ELSE 0.0 END) * 100 as completion_rate
                FROM appointments
              `),
              
              // Health records analytics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_records,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_records,
                  COUNT(DISTINCT COALESCE(uid::text, phone)) as patients_with_records,
                  SUM(CASE WHEN file_type LIKE 'image%' THEN 1 ELSE 0 END) as image_records,
                  SUM(CASE WHEN file_type = 'application/pdf' THEN 1 ELSE 0 END) as pdf_records,
                  AVG(file_size) as avg_file_size
                FROM health_records
              `),
              
              // Investigation analytics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_investigations,
                  COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '${interval}') as recent_investigations,
                  COUNT(*) FILTER (WHERE status = 'PENDING') as pending_investigations,
                  COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed_investigations,
                  COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_investigations,
                  COUNT(DISTINCT patient_id) as patients_with_investigations,
                  AVG(CASE WHEN completed_at IS NOT NULL AND requested_at IS NOT NULL 
                    THEN EXTRACT(EPOCH FROM (completed_at - requested_at))/3600 END) as avg_completion_hours
                FROM investigations
              `),
              
              // Pharmacy analytics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_orders,
                  COUNT(*) FILTER (WHERE ordered_at > NOW() - INTERVAL '${interval}') as recent_orders,
                  COUNT(*) FILTER (WHERE status = 'PENDING') as pending_orders,
                  COUNT(*) FILTER (WHERE status = 'FULFILLED') as fulfilled_orders,
                  COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_orders,
                  COUNT(DISTINCT patient_id) as unique_customers,
                  COALESCE(SUM(total_amount), 0) as total_revenue,
                  COALESCE(AVG(total_amount), 0) as avg_order_value
                FROM pharmacy_orders
                WHERE ordered_at > NOW() - INTERVAL '${interval}'
              `),
              
              // Feedback analytics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_feedback,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_feedback,
                  ROUND(AVG(rating), 2) as average_rating,
                  COUNT(*) FILTER (WHERE rating >= 4) as positive_feedback,
                  COUNT(*) FILTER (WHERE rating <= 2) as negative_feedback,
                  COUNT(*) FILTER (WHERE rating = 3) as neutral_feedback,
                  COUNT(DISTINCT COALESCE(uid::text, phone)) as unique_reviewers
                FROM feedback
              `),
              
              // SOS analytics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_alerts,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_alerts,
                  COUNT(*) FILTER (WHERE status = 'ACTIVE') as active_alerts,
                  COUNT(*) FILTER (WHERE severity = 'CRITICAL') as critical_alerts,
                  COUNT(*) FILTER (WHERE severity = 'HIGH') as high_priority_alerts,
                  COUNT(*) FILTER (WHERE status = 'RESOLVED') as resolved_alerts,
                  AVG(CASE
                    WHEN raised_at IS NOT NULL AND COALESCE(responded_at, resolved_at) IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (COALESCE(responded_at, resolved_at) - raised_at)) / 60
                  END) as avg_response_time
                FROM sos_alerts
              `)
            ]);

            const analytics = {
              timeframe,
              userAnalytics: userStats[0],
              appointmentAnalytics: appointmentStats[0],
              healthRecordAnalytics: healthRecordStats[0],
              investigationAnalytics: investigationStats[0],
              pharmacyAnalytics: pharmacyStats[0],
              feedbackAnalytics: feedbackStats[0],
              sosAnalytics: sosStats[0],
              generatedAt: new Date().toISOString(),
              requestedBy: req.user?.name || 'Unknown'
            };

            success(res, analytics, 'Dashboard analytics retrieved successfully');

          } catch (err) {
            logger.error('Dashboard Analytics Error:', err);
            return analyticsUnavailable(res, 'Dashboard analytics unavailable. No synthetic analytics were returned.');
          }
        }
      ],

      // 📈 Trend Analysis
      [
        '/trends',
        async (req, res) => {
        const { metric = 'users', period = 'daily' } = req.query;
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  
        try {
            let dateFormat, groupBy;
            switch (period) {
              case 'hourly': 
                dateFormat = 'YYYY-MM-DD HH24:00:00';
                groupBy = 'hour';
                break;
              case 'daily':
                dateFormat = 'YYYY-MM-DD';
                groupBy = 'day';
                break;
              case 'weekly':
                dateFormat = 'YYYY-"W"WW';
                groupBy = 'week';
                break;
              case 'monthly':
                dateFormat = 'YYYY-MM';
                groupBy = 'month';
                break;
              default:
                dateFormat = 'YYYY-MM-DD';
                groupBy = 'day';
            }

            let tableName, dateField, additionalFields = '', uniqueEntityExpression = 'id';
            switch (metric) {
              case 'users':
                tableName = 'users';
                dateField = 'registered_at';
                uniqueEntityExpression = 'id';
                additionalFields = ', COUNT(*) FILTER (WHERE role = \'DOCTOR\') as doctors, COUNT(*) FILTER (WHERE role = \'PATIENT\') as patients';
                break;
              case 'appointments':
                tableName = 'appointments';
                dateField = 'created_at';
                uniqueEntityExpression = 'patient_id';
                additionalFields = ', COUNT(*) FILTER (WHERE status = \'COMPLETED\') as completed, COUNT(*) FILTER (WHERE status = \'CANCELLED\') as cancelled';
                break;
              case 'investigations':
                tableName = 'investigations';
                dateField = 'requested_at';
                uniqueEntityExpression = 'patient_id';
                additionalFields = ', COUNT(*) FILTER (WHERE status = \'COMPLETED\') as completed, COUNT(*) FILTER (WHERE status = \'PENDING\') as pending';
                break;
              case 'feedback':
                tableName = 'feedback';
                dateField = 'created_at';
                uniqueEntityExpression = 'COALESCE(uid::text, phone)';
                additionalFields = ', AVG(rating) as avg_rating, COUNT(*) FILTER (WHERE rating >= 4) as positive';
                break;
              case 'pharmacy':
                tableName = 'pharmacy_orders';
                dateField = 'ordered_at';
                uniqueEntityExpression = 'COALESCE(patient_id::text, uid::text, phone)';
                additionalFields = ', SUM(total_amount) as revenue, AVG(total_amount) as avg_order_value';
                break;
              default:
                return error(res, 'Invalid metric specified. Valid options: users, appointments, investigations, feedback, pharmacy', HTTP_STATUS.BAD_REQUEST);
            }

            const trends = await prisma.$queryRawUnsafe(`
              SELECT 
                TO_CHAR(${dateField}, '${dateFormat}') as period,
                COUNT(*) as count,
                COUNT(DISTINCT ${uniqueEntityExpression}) as unique_entities
                ${additionalFields}
              FROM ${tableName}
              WHERE ${dateField} > NOW() - INTERVAL '${days} days'
              GROUP BY TO_CHAR(${dateField}, '${dateFormat}')
              ORDER BY period DESC
              LIMIT 100
            `);

            success(res, {
              metric,
              period: groupBy,
              days,
              trends: trends,
              totalDataPoints: trends.length,
              requestedBy: req.user?.name
            }, 'Trend analysis completed successfully');

          } catch (err) {
            logger.error('Trend Analysis Error:', err);
            return analyticsUnavailable(res, 'Trend analytics unavailable. No synthetic analytics were returned.');
          }
        }
      ],

      // 📋 Department Performance Analytics
      [
        '/departments',
        async (req, res) => {
         const { timeframe = '30d' } = req.query;

          try {
            
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              default: interval = '30 days';
            }

            const departmentStats = await prisma.$queryRawUnsafe(`
              SELECT
                d.name AS department,
                COUNT(DISTINCT doc.user_id) as total_doctors,
                COUNT(DISTINCT doc.user_id) FILTER (WHERE doc.is_available = true) as available_doctors,
                COUNT(a.id) as total_appointments,
                COUNT(a.id) FILTER (WHERE a.status = 'COMPLETED') as completed_appointments,
                COUNT(a.id) FILTER (WHERE a.created_at > NOW() - INTERVAL '${interval}') as recent_appointments,
                AVG(doc.consultation_fee) as avg_consultation_fee,
                SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as total_revenue
              FROM departments d
              LEFT JOIN doctors doc ON d.name = doc.department
              LEFT JOIN users u ON doc.user_id = u.id
              LEFT JOIN appointments a ON u.id = a.doctor_id
              GROUP BY d.name
              ORDER BY total_appointments DESC
            `);

            success(res, {
              timeframe,
              departments: departmentStats,
              totalDepartments: departmentStats.length,
              requestedBy: req.user?.name,
              generatedAt: new Date().toISOString()
            }, 'Department analytics retrieved successfully');

          } catch (err) {
            logger.error('Department Analytics Error:', err);
            return analyticsUnavailable(res, 'Department analytics unavailable. No synthetic analytics were returned.');
          }
        }
      ],

      // 💊 Pharmacy Analytics
      [
        '/pharmacy',
        async (req, res) => {
          const { timeframe = '30d' } = req.query;

          try {
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              default: interval = '30 days';
            }

            const [orderStats, topMedicines, revenueByDay] = await Promise.all([
              // Order statistics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_orders,
                  COUNT(*) FILTER (WHERE ordered_at > NOW() - INTERVAL '${interval}') as recent_orders,
                  COUNT(*) FILTER (WHERE status = 'PENDING') as pending_orders,
                  COUNT(*) FILTER (WHERE status = 'FULFILLED') as fulfilled_orders,
                  COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_orders,
                  COUNT(DISTINCT patient_id) as unique_customers,
                  COALESCE(SUM(total_amount), 0) as total_revenue,
                  COALESCE(AVG(total_amount), 0) as avg_order_value,
                  COALESCE(MAX(total_amount), 0) as highest_order_value
                FROM pharmacy_orders
                WHERE ordered_at > NOW() - INTERVAL '${interval}'
              `),
              
              // Top medicines
              prisma.$queryRawUnsafe(`
                SELECT 
                  COALESCE(medication, order_note, 'Unspecified') as medicine_name,
                  COUNT(*) as total_quantity_sold,
                  COUNT(*) as order_frequency,
                  SUM(total_amount) as medicine_revenue
                FROM pharmacy_orders
                WHERE ordered_at > NOW() - INTERVAL '${interval}' AND status = 'FULFILLED'
                GROUP BY COALESCE(medication, order_note, 'Unspecified')
                ORDER BY total_quantity_sold DESC
                LIMIT 10
              `),
              
              // Daily revenue trend
              prisma.$queryRawUnsafe(`
                SELECT 
                  DATE(ordered_at) as order_date,
                  COUNT(*) as daily_orders,
                  SUM(total_amount) as daily_revenue,
                  COUNT(DISTINCT patient_id) as unique_customers
                FROM pharmacy_orders
                WHERE ordered_at > NOW() - INTERVAL '${interval}'
                GROUP BY DATE(ordered_at)
                ORDER BY order_date DESC
              `)
            ]);

            success(res, {
              timeframe,
              orderStatistics: orderStats[0],
              topMedicines: topMedicines,
              dailyRevenue: revenueByDay,
              requestedBy: req.user?.name,
              generatedAt: new Date().toISOString()
            }, 'Pharmacy analytics retrieved successfully');

          } catch (err) {
            logger.error('Pharmacy Analytics Error:', err);
            return analyticsUnavailable(res, 'Pharmacy analytics unavailable. No synthetic analytics were returned.');
          }
        }
      ],

      // ⭐ Patient Satisfaction Analytics
      [
        '/satisfaction',
        async (req, res) => {
          const { timeframe = '30d' } = req.query;
          try {
            
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              default: interval = '30 days';
            }

            const [ratingStats, departmentRatings, timelyRatings] = await Promise.all([
              // Overall satisfaction statistics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_feedback,
                  ROUND(AVG(rating), 2) as average_rating,
                  COUNT(*) FILTER (WHERE rating = 5) as five_star,
                  COUNT(*) FILTER (WHERE rating = 4) as four_star,
                  COUNT(*) FILTER (WHERE rating = 3) as three_star,
                  COUNT(*) FILTER (WHERE rating = 2) as two_star,
                  COUNT(*) FILTER (WHERE rating = 1) as one_star,
                  COUNT(*) FILTER (WHERE rating >= 4) as positive_feedback,
                  COUNT(*) FILTER (WHERE rating <= 2) as negative_feedback,
                  COUNT(DISTINCT COALESCE(uid::text, phone)) as unique_reviewers
                FROM feedback
                WHERE created_at > NOW() - INTERVAL '${interval}'
              `),
              
              // Department-wise ratings
              prisma.$queryRawUnsafe(`
                SELECT
                  d.name AS department,
                  COUNT(f.id) as feedback_count,
                  ROUND(AVG(f.rating), 2) as avg_rating,
                  COUNT(*) FILTER (WHERE f.rating >= 4) as positive_count
                FROM feedback f
                JOIN appointments a ON f.appointment_id = a.id
                JOIN users u ON a.doctor_id = u.id
                JOIN doctors doc ON u.id = doc.user_id
                JOIN departments d ON doc.department = d.name
                WHERE f.created_at > NOW() - INTERVAL '${interval}'
                GROUP BY d.name
                ORDER BY avg_rating DESC
              `),
              
              // Rating trends over time
              prisma.$queryRawUnsafe(`
                SELECT 
                  DATE(created_at) as feedback_date,
                  COUNT(*) as daily_feedback,
                  ROUND(AVG(rating), 2) as daily_avg_rating,
                  COUNT(*) FILTER (WHERE rating >= 4) as daily_positive
                FROM feedback
                WHERE created_at > NOW() - INTERVAL '${interval}'
                GROUP BY DATE(created_at)
                ORDER BY feedback_date DESC
              `)
            ]);

            success(res, {
              timeframe,
              overallSatisfaction: ratingStats[0],
              departmentRatings: departmentRatings,
              ratingTrends: timelyRatings,
              requestedBy: req.user?.name,
              generatedAt: new Date().toISOString()
            }, 'Patient satisfaction analytics retrieved successfully');

          } catch (err) {
            logger.error('Satisfaction Analytics Error:', err);
            return analyticsUnavailable(res, 'Patient satisfaction analytics unavailable. No synthetic analytics were returned.');
          }
        }
      ],

      // 🏥 System Usage Analytics
      [
        '/usage',
        async (req, res) => {
        const { timeframe = '30d' } = req.query;
            try {
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              default: interval = '30 days';
            }

            const [featureUsage, deviceStats, peakHours] = await Promise.all([
              // Feature usage statistics
              prisma.$queryRawUnsafe(`
                SELECT 
                  'Appointments' as feature,
                  COUNT(*) as usage_count
                FROM appointments
                WHERE created_at > NOW() - INTERVAL '${interval}'
                UNION ALL
                SELECT 
                  'Health Records' as feature,
                  COUNT(*) as usage_count
                FROM health_records
                WHERE created_at > NOW() - INTERVAL '${interval}'
                UNION ALL
                SELECT 
                  'Investigations' as feature,
                  COUNT(*) as usage_count
                FROM investigations
                WHERE requested_at > NOW() - INTERVAL '${interval}'
                UNION ALL
                SELECT 
                  'Pharmacy Orders' as feature,
                  COUNT(*) as usage_count
                FROM pharmacy_orders
                WHERE ordered_at > NOW() - INTERVAL '${interval}'
                ORDER BY usage_count DESC
              `),
              
              // Device/platform statistics (if available)
              prisma.$queryRawUnsafe(`
                SELECT 
                  device_type,
                  platform,
                  COUNT(*) as session_count,
                  COUNT(DISTINCT user_id) as unique_users
                FROM user_sessions
                WHERE created_at > NOW() - INTERVAL '${interval}'
                GROUP BY device_type, platform
                ORDER BY session_count DESC
              `),
              
              // Peak usage hours
              prisma.$queryRawUnsafe(`
                SELECT 
                  EXTRACT(HOUR FROM created_at) as hour_of_day,
                  COUNT(*) as activity_count
                FROM (
                  SELECT created_at FROM appointments WHERE created_at > NOW() - INTERVAL '${interval}'
                  UNION ALL
                  SELECT created_at FROM health_records WHERE created_at > NOW() - INTERVAL '${interval}'
                  UNION ALL
                  SELECT requested_at as created_at FROM investigations WHERE requested_at > NOW() - INTERVAL '${interval}'
                ) all_activities
                GROUP BY EXTRACT(HOUR FROM created_at)
                ORDER BY hour_of_day
              `)
            ]);

            success(res, {
              timeframe,
              featureUsage: featureUsage,
              deviceStatistics: deviceStats,
              peakUsageHours: peakHours,
              requestedBy: req.user?.name,
              generatedAt: new Date().toISOString()
            }, 'System usage analytics retrieved successfully');

          } catch (err) {
            logger.error('Usage Analytics Error:', err);
            return analyticsUnavailable(res, 'System usage analytics unavailable. No synthetic analytics were returned.');
          }
        }
      ],

      // Legacy routes from original controller (maintained for backward compatibility)
      ['/registrations', analyticsController.getUserRegistrations],
      ['/counts', analyticsController.getEntityCounts],
      ['/active-users', analyticsController.getActiveUsers],
      ['/active-departments', analyticsController.getActiveDepartments]
    ]
  },
  {
    requireUID: true,        // Require user authentication
    requirePhone: false,     // Phone not required for analytics
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR'] // Allow both admin and doctor roles
  }
);

export default router;
