// ========================================
// src/routes/analyticsRoutes.js - CORRECTED
// ========================================
import express from 'express';
import * as analyticsController from '../controllers/analyticsController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS } from '../config/responseCodes.js';

const router = express.Router(); // ✅ Fixed: was analyticsRouter

wrapAutoRBAC(router, 'analyticsRoutes', {
  get: [
    // 📊 Comprehensive Dashboard Analytics
    [
      '/dashboard',
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

          // Parallel queries for comprehensive analytics
          const [
            userStats, appointmentStats, healthRecordStats, 
            investigationStats, pharmacyStats, feedbackStats, sosStats
          ] = await Promise.all([
            // User analytics
            pool.query(`
              SELECT 
                COUNT(*) as total_users,
                COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '${interval}') as new_users,
                COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_users_7d,
                COUNT(*) FILTER (WHERE role = 'PATIENT') as patients,
                COUNT(*) FILTER (WHERE role = 'DOCTOR') as doctors,
                COUNT(*) FILTER (WHERE role = 'NURSING_STAFF') as nursing_staff
              FROM users
            `),
            
            // Appointment analytics
            pool.query(`
              SELECT 
                COUNT(*) as total_appointments,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_appointments,
                COUNT(*) FILTER (WHERE date >= CURRENT_DATE) as upcoming_appointments,
                COUNT(*) FILTER (WHERE date < CURRENT_DATE) as completed_appointments,
                COUNT(DISTINCT phone) as unique_patients
              FROM appointments
            `),
            
            // Health records analytics
            pool.query(`
              SELECT 
                COUNT(*) as total_records,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_records,
                COUNT(DISTINCT phone) as patients_with_records,
                SUM(CASE WHEN file_type LIKE 'image%' THEN 1 ELSE 0 END) as image_records,
                SUM(CASE WHEN file_type = 'application/pdf' THEN 1 ELSE 0 END) as pdf_records
              FROM health_records
            `),
            
            // Investigation analytics
            pool.query(`
              SELECT 
                COUNT(*) as total_investigations,
                COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '${interval}') as recent_investigations,
                COUNT(*) FILTER (WHERE status = 'pending') as pending_investigations,
                COUNT(*) FILTER (WHERE status = 'completed') as completed_investigations,
                COUNT(DISTINCT phone) as patients_with_investigations
              FROM investigations
            `),
            
            // Pharmacy analytics
            pool.query(`
              SELECT 
                COUNT(*) as total_orders,
                COUNT(*) FILTER (WHERE placed_at > NOW() - INTERVAL '${interval}') as recent_orders,
                COUNT(*) FILTER (WHERE status = 'pending') as pending_orders,
                COUNT(*) FILTER (WHERE status = 'fulfilled') as fulfilled_orders,
                COUNT(DISTINCT phone) as unique_customers
              FROM pharmacy_orders
            `),
            
            // Feedback analytics
            pool.query(`
              SELECT 
                COUNT(*) as total_feedback,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_feedback,
                AVG(rating) as average_rating,
                COUNT(*) FILTER (WHERE rating >= 4) as positive_feedback,
                COUNT(*) FILTER (WHERE rating <= 2) as negative_feedback
              FROM feedback
            `),
            
            // SOS analytics
            pool.query(`
              SELECT 
                COUNT(*) as total_alerts,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${interval}') as recent_alerts,
                COUNT(*) FILTER (WHERE status = 'active') as active_alerts,
                COUNT(*) FILTER (WHERE severity = 'critical') as critical_alerts,
                AVG(response_time_minutes) as avg_response_time
              FROM sos_alerts
            `)
          ]);

          success(res, {
            timeframe,
            userAnalytics: userStats.rows[0],
            appointmentAnalytics: appointmentStats.rows[0],
            healthRecordAnalytics: healthRecordStats.rows[0],
            investigationAnalytics: investigationStats.rows[0],
            pharmacyAnalytics: pharmacyStats.rows[0],
            feedbackAnalytics: feedbackStats.rows[0],
            sosAnalytics: sosStats.rows[0],
            generatedAt: new Date().toISOString()
          }, 'Dashboard analytics retrieved');

        } catch (err) {
          logger.error('Dashboard Analytics Error:', err);
          error(res, 'Failed to fetch dashboard analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📈 Trend Analysis
    [
      '/trends',
      async (req, res) => {
        try {
          const { metric = 'users', period = 'daily', days = 30 } = req.query;
          
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

          let tableName, dateField;
          switch (metric) {
            case 'users':
              tableName = 'users';
              dateField = 'registered_at';
              break;
            case 'appointments':
              tableName = 'appointments';
              dateField = 'created_at';
              break;
            case 'investigations':
              tableName = 'investigations';
              dateField = 'requested_at';
              break;
            case 'feedback':
              tableName = 'feedback';
              dateField = 'created_at';
              break;
            default:
              return error(res, 'Invalid metric specified', HTTP_STATUS.BAD_REQUEST);
          }

          const trends = await pool.query(`
            SELECT 
              TO_CHAR(${dateField}, '${dateFormat}') as period,
              COUNT(*) as count,
              COUNT(DISTINCT phone) as unique_users
            FROM ${tableName}
            WHERE ${dateField} > NOW() - INTERVAL '${days} days'
            GROUP BY TO_CHAR(${dateField}, '${dateFormat}')
            ORDER BY period DESC
          `);

          success(res, {
            metric,
            period: groupBy,
            days: parseInt(days),
            trends: trends.rows,
            totalDataPoints: trends.rows.length
          }, 'Trend analysis completed');

        } catch (err) {
          logger.error('Trend Analysis Error:', err);
          error(res, 'Failed to generate trend analysis', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Legacy routes from original controller
    ['/registrations', analyticsController.getUserRegistrations],
    ['/counts', analyticsController.getEntityCounts],
    ['/active-users', analyticsController.getActiveUsers],
    ['/active-departments', analyticsController.getActiveDepartments]
  ]
});

export default router; // ✅ Added missing export

// ========================================
// src/routes/lookupRoutes.js - CORRECTED
// ========================================
import express from 'express';
import * as userController from '../controllers/userController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import logger from '../logging/logger.js'; // ✅ Added missing import
import { HTTP_STATUS } from '../config/responseCodes.js'; // ✅ Added missing import

const router = express.Router(); // ✅ Fixed: was lookupRouter

wrapAutoRBAC(router, 'lookupRoutes', {
  get: [
    // 🔍 Enhanced User Lookup
    [
      '/',
      async (req, res) => {
        const { phone, uid, name, email, limit = 10 } = req.query;

        if (!phone && !uid && !name && !email) {
          return error(res, 'Provide phone, uid, name, or email to search', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          let query = 'SELECT uid, phone, name, email, role, registered_at FROM users WHERE ';
          const params = [];
          const conditions = [];

          if (phone) {
            conditions.push(`phone = $${params.length + 1}`); // ✅ Fixed: added missing $
            params.push(normalizePhone(phone));
          }

          if (uid) {
            conditions.push(`uid = $${params.length + 1}`); // ✅ Fixed: added missing $
            params.push(uid);
          }

          if (name) {
            conditions.push(`LOWER(name) LIKE $${params.length + 1}`); // ✅ Fixed: added missing $
            params.push(`%${name.toLowerCase()}%`);
          }

          if (email) {
            conditions.push(`LOWER(email) LIKE $${params.length + 1}`); // ✅ Fixed: added missing $
            params.push(`%${email.toLowerCase()}%`);
          }

          query += conditions.join(' OR ');
          query += ` ORDER BY registered_at DESC LIMIT $${params.length + 1}`; // ✅ Fixed: added missing $
          params.push(parseInt(limit));

          const result = await pool.query(query, params);

          if (result.rows.length === 0) {
            return success(res, {
              users: [],
              totalFound: 0,
              searchCriteria: { phone, uid, name, email }
            }, 'No matching users found');
          }

          success(res, {
            users: result.rows,
            totalFound: result.rows.length,
            searchCriteria: { phone, uid, name, email }
          }, `Found ${result.rows.length} matching user(s)`);

        } catch (err) {
          logger.error('User Lookup Error:', err);
          error(res, 'User lookup failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Lookup Statistics
    [
      '/stats',
      async (req, res) => {
        try {
          const stats = await pool.query(`
            SELECT 
              COUNT(*) as total_users,
              COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days') as new_users_30d,
              COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_users_7d,
              COUNT(DISTINCT role) as unique_roles,
              MIN(registered_at) as first_registration,
              MAX(registered_at) as latest_registration
            FROM users
          `);

          const roleDistribution = await pool.query(`
            SELECT role, COUNT(*) as count
            FROM users 
            GROUP BY role 
            ORDER BY count DESC
          `);

          success(res, {
            overallStats: stats.rows[0],
            roleDistribution: roleDistribution.rows,
            generatedAt: new Date().toISOString()
          }, 'Lookup statistics retrieved');

        } catch (err) {
          logger.error('Lookup Stats Error:', err);
          error(res, 'Failed to fetch lookup statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
},
{
  requireUID: false,
  requirePhone: false
});

export default router; // ✅ Added missing export

// ========================================
// src/routes/versionRoutes.js - CORRECTED
// ========================================
import express from 'express';
import { success } from '../utils/responseHelper.js';
import { wrapRoutes } from '../config/routeWrapper.js';
import fs from 'fs';
import path from 'path';

const router = express.Router(); // ✅ Fixed: was versionRouter

// Read package.json for version info
let packageInfo = { version: '1.0.0', name: 'vh-health-backend' };
try {
  const packagePath = path.resolve('package.json');
  packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
} catch (err) {
  console.warn('Could not read package.json for version info');
}

wrapRoutes(
  router,
  [],
  {
    get: [
      [
        '/',
        (req, res) => {
          const versionInfo = {
            name: packageInfo.name,
            version: packageInfo.version,
            apiVersion: 'v1',
            buildDate: process.env.BUILD_DATE || new Date().toISOString().split('T')[0],
            environment: process.env.NODE_ENV || 'development',
            nodeVersion: process.version,
            uptime: Math.floor(process.uptime()),
            features: [
              'User Management',
              'Appointment Booking', 
              'Health Records',
              'Emergency SOS',
              'File Upload',
              'Analytics',
              'RBAC',
              'Firebase Auth',
              'OTP System'
            ],
            endpoints: {
              health: '/api/v1/health',
              docs: '/api-docs',
              version: '/api/v1/version'
            },
            lastUpdated: '2025-06-24',
            message: `${packageInfo.name} v${packageInfo.version} - Healthcare API`
          };

          success(res, versionInfo, 'Version information retrieved');
        }
      ],

      // 🏥 API Capabilities
      [
        '/capabilities',
        (req, res) => {
          const capabilities = {
            authentication: {
              methods: ['OTP', 'Firebase', 'JWT'],
              roles: ['ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'PATIENT'],
              features: ['Multi-factor auth', 'Role-based access', 'Session management']
            },
            modules: {
              userManagement: { enabled: true, version: '1.0' },
              appointments: { enabled: true, version: '1.0' },
              healthRecords: { enabled: true, version: '1.0' },
              investigations: { enabled: true, version: '1.0' },
              pharmacy: { enabled: true, version: '1.0' },
              emergencySOS: { enabled: true, version: '1.0' },
              fileUploads: { enabled: true, version: '1.0' },
              analytics: { enabled: true, version: '1.0' },
              notifications: { enabled: true, version: '1.0' }
            },
            integrations: {
              firebase: { enabled: !!process.env.FIREBASE_PROJECT_ID },
              cloudStorage: { enabled: !!process.env.CF_R2_BUCKET },
              pushNotifications: { enabled: true },
              virusScanning: { enabled: !!process.env.CLAMAV_API_URL }
            },
            limits: {
              fileUploadSize: '10MB',
              dailyOTPLimit: 10,
              rateLimits: 'Role-based'
            }
          };

          success(res, capabilities, 'API capabilities retrieved');
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;