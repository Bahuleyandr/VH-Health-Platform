// src/routes/otpAdminRoutes.js - ADVANCED OTP ADMIN ANALYTICS & MANAGEMENT

import express from 'express';
import { validationResult, body, query } from 'express-validator';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { DatabaseManager } from '../config/database.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { logAudit } from '../utils/logAudit.js';

const router = express.Router();
const db = DatabaseManager.getInstance();

logger.info('📊 OTP Admin Analytics routes loaded');

// ✅ OTP Configuration (should match main OTP config)
const OTP_CONFIG = {
  length: 6,
  expirationMinutes: parseInt(process.env.OTP_EXPIRATION_MINUTES) || 5,
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS) || 3,
  resendCooldownMinutes: parseInt(process.env.OTP_RESEND_COOLDOWN) || 1,
  dailyLimit: parseInt(process.env.OTP_DAILY_LIMIT) || 10,
  devMode: process.env.NODE_ENV === 'development'
};

// ✅ Admin validation schemas
const adminOtpValidator = [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('purpose').optional().isString().withMessage('Purpose must be string'),
  body('reason').optional().isString().withMessage('Reason must be string')
];

// ✅ Log OTP activity (duplicate from main file for admin operations)
async function logOTPActivity(phone, purpose, action, success, failureReason = null, req) {
  try {
    await db.query(`
      INSERT INTO otp_logs (
        phone, purpose, action, success, failure_reason, 
        ip_address, user_agent, created_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
    `, [
      phone, purpose, action, success, failureReason,
      req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
      req.headers['user-agent'],
      req.user?.uid || 'anonymous'
    ]);
  } catch (dbError) {
    logger.warn('OTP admin log fallback:', dbError.message);
    logger.info(`[OTP_ADMIN_LOG] ${phone} | ${purpose} | ${action} | ${success ? 'SUCCESS' : 'FAIL'} | ${failureReason || ''}`);
  }
}

// ✅ ADMIN ROUTES - Full RBAC protection (ADMIN only)
wrapAutoRBAC(router, 'ALL', {
  get: [
    // 📋 OTP Usage Analytics
    [
      '/analytics',
      [
        query('startDate').optional().isISO8601().withMessage('Invalid start date'),
        query('endDate').optional().isISO8601().withMessage('Invalid end date'),
        query('purpose').optional().isString().withMessage('Purpose must be string')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { startDate, endDate, purpose } = req.query;
          const requestedBy = req.user?.uid;
          
          let whereClause = 'WHERE 1=1';
          const params = [];

          if (startDate) {
            whereClause += ` AND created_at >= $${params.length + 1}`;
            params.push(startDate);
          }

          if (endDate) {
            whereClause += ` AND created_at <= $${params.length + 1}`;
            params.push(endDate);
          }

          if (purpose) {
            whereClause += ` AND purpose = $${params.length + 1}`;
            params.push(purpose);
          }

          const [usageStats, failureStats, topUsers] = await Promise.all([
            // Usage statistics
            db.query(`
              SELECT 
                DATE(created_at) as date,
                purpose,
                action,
                COUNT(*) as total_count,
                COUNT(*) FILTER (WHERE success = true) as successful_count,
                COUNT(*) FILTER (WHERE success = false) as failed_count,
                COUNT(DISTINCT phone) as unique_users
              FROM otp_logs 
              ${whereClause}
              GROUP BY DATE(created_at), purpose, action
              ORDER BY date DESC, purpose, action
            `, params),

            // Failure analysis
            db.query(`
              SELECT 
                failure_reason,
                COUNT(*) as count,
                COUNT(DISTINCT phone) as unique_users
              FROM otp_logs 
              ${whereClause} AND success = false
              GROUP BY failure_reason
              ORDER BY count DESC
            `, params),

            // Top users by OTP requests
            db.query(`
              SELECT 
                phone,
                COUNT(*) as otp_requests,
                COUNT(DISTINCT purpose) as purposes_used,
                COUNT(*) FILTER (WHERE success = true AND action = 'verify') as successful_verifications
              FROM otp_logs 
              ${whereClause}
              GROUP BY phone
              ORDER BY otp_requests DESC
              LIMIT 20
            `, params)
          ]);

          await logAudit(req, 'otp-analytics-viewed', { 
            period: { startDate, endDate, purpose },
            recordCount: usageStats.rows.length
          });

          success(res, {
            usageStatistics: usageStats.rows,
            failureAnalysis: failureStats.rows,
            topUsers: topUsers.rows,
            queryPeriod: { startDate, endDate, purpose },
            generatedBy: requestedBy,
            timestamp: new Date().toISOString()
          }, 'OTP analytics retrieved successfully');

        } catch (err) {
          logger.error('OTP Analytics Error:', err);
          error(res, 'Failed to fetch OTP analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🚨 OTP Security Alerts
    [
      '/security-alerts',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid;

          const [suspiciousActivity, failurePatterns, ipAnalysis] = await Promise.all([
            // Unusual OTP activity patterns
            db.query(`
              SELECT 
                phone,
                COUNT(*) as otp_requests,
                COUNT(DISTINCT ip_address) as different_ips,
                array_agg(DISTINCT failure_reason) FILTER (WHERE failure_reason IS NOT NULL) as failure_reasons,
                MIN(created_at) as first_request,
                MAX(created_at) as last_request
              FROM otp_logs 
              WHERE created_at > NOW() - INTERVAL '24 hours'
              GROUP BY phone
              HAVING COUNT(*) > 20 OR COUNT(DISTINCT ip_address) > 5
              ORDER BY otp_requests DESC
            `),

            // Failed verification patterns
            db.query(`
              SELECT 
                phone,
                COUNT(*) as failed_attempts,
                array_agg(DISTINCT failure_reason) as reasons,
                COUNT(DISTINCT ip_address) as different_ips
              FROM otp_logs 
              WHERE created_at > NOW() - INTERVAL '6 hours'
                AND success = false
                AND action = 'verify'
              GROUP BY phone
              HAVING COUNT(*) >= $1
              ORDER BY failed_attempts DESC
            `, [OTP_CONFIG.maxAttempts * 2]),

            // IP address analysis
            db.query(`
              SELECT 
                ip_address,
                COUNT(DISTINCT phone) as unique_phones,
                COUNT(*) as total_requests,
                array_agg(DISTINCT phone) as phones
              FROM otp_logs 
              WHERE created_at > NOW() - INTERVAL '24 hours'
                AND ip_address IS NOT NULL
              GROUP BY ip_address
              HAVING COUNT(DISTINCT phone) > 10
              ORDER BY unique_phones DESC
            `)
          ]);

          await logAudit(req, 'otp-security-alerts-viewed', {
            suspiciousCount: suspiciousActivity.rows.length,
            failurePatternCount: failurePatterns.rows.length,
            suspiciousIPCount: ipAnalysis.rows.length
          });

          success(res, {
            suspiciousActivity: suspiciousActivity.rows,
            failurePatterns: failurePatterns.rows,
            ipAnalysis: ipAnalysis.rows,
            alertsGenerated: new Date().toISOString(),
            recommendations: {
              suspiciousUsers: suspiciousActivity.rows.length,
              shouldInvestigate: failurePatterns.rows.length > 0,
              suspiciousIPs: ipAnalysis.rows.length
            },
            generatedBy: requestedBy
          }, 'OTP security alerts generated successfully');

        } catch (err) {
          logger.error('OTP Security Alerts Error:', err);
          error(res, 'Failed to generate security alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📱 Active OTP Sessions
    [
      '/active-sessions',
      [
        query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be 1-500')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const limit = parseInt(req.query.limit) || 100;
          const requestedBy = req.user?.uid;

          const result = await db.query(`
            SELECT 
              id, phone, purpose, created_at, expires_at, 
              attempts, verified, user_id,
              EXTRACT(EPOCH FROM (expires_at - NOW())) as remaining_seconds
            FROM otp_sessions 
            WHERE verified = false AND expires_at > NOW()
            ORDER BY created_at DESC
            LIMIT $1
          `, [limit]);

          // Group by purpose for summary
          const byPurpose = result.rows.reduce((acc, session) => {
            acc[session.purpose] = (acc[session.purpose] || 0) + 1;
            return acc;
          }, {});

          await logAudit(req, 'otp-active-sessions-viewed', { 
            sessionCount: result.rows.length 
          });

          success(res, {
            activeSessions: result.rows.map(session => ({
              ...session,
              remaining_seconds: Math.max(0, Math.floor(session.remaining_seconds))
            })),
            totalActive: result.rows.length,
            byPurpose,
            generatedBy: requestedBy,
            timestamp: new Date().toISOString()
          }, 'Active OTP sessions retrieved successfully');

        } catch (err) {
          logger.error('Active Sessions Error:', err);
          error(res, 'Failed to fetch active sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 OTP Logs with Advanced Filtering
    [
      '/logs',
      [
        query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
        query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be 1-500'),
        query('phone').optional().isString().withMessage('Phone must be string'),
        query('purpose').optional().isString().withMessage('Purpose must be string'),
        query('action').optional().isIn(['request', 'verify', 'resend']).withMessage('Invalid action'),
        query('success').optional().isIn(['true', 'false']).withMessage('Success must be true or false'),
        query('startDate').optional().isISO8601().withMessage('Invalid start date'),
        query('endDate').optional().isISO8601().withMessage('Invalid end date'),
        query('ipAddress').optional().isString().withMessage('IP address must be string')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { 
            page = 1, limit = 100, phone, purpose, action, 
            success, startDate, endDate, ipAddress 
          } = req.query;
          
          const offset = (page - 1) * limit;
          const requestedBy = req.user?.uid;
          
          let whereClause = 'WHERE 1=1';
          const params = [limit, offset];
          let paramIndex = 3;

          if (phone) {
            const normalizedPhone = normalizePhone(phone);
            whereClause += ` AND phone = $${paramIndex}`;
            params.push(normalizedPhone);
            paramIndex++;
          }

          if (purpose) {
            whereClause += ` AND purpose = $${paramIndex}`;
            params.push(purpose);
            paramIndex++;
          }

          if (action) {
            whereClause += ` AND action = $${paramIndex}`;
            params.push(action);
            paramIndex++;
          }

          if (success !== undefined) {
            whereClause += ` AND success = $${paramIndex}`;
            params.push(success === 'true');
            paramIndex++;
          }

          if (startDate) {
            whereClause += ` AND created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
          }

          if (endDate) {
            whereClause += ` AND created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
          }

          if (ipAddress) {
            whereClause += ` AND ip_address = $${paramIndex}`;
            params.push(ipAddress);
            paramIndex++;
          }

          const [logs, total] = await Promise.all([
            db.query(`
              SELECT 
                id, phone, purpose, action, success, failure_reason,
                ip_address, user_agent, created_at, created_by
              FROM otp_logs 
              ${whereClause}
              ORDER BY created_at DESC
              LIMIT $1 OFFSET $2
            `, params),

            db.query(
              `SELECT COUNT(*) FROM otp_logs ${whereClause}`,
              params.slice(2)
            )
          ]);

          await logAudit(req, 'otp-logs-viewed', {
            filters: { phone, purpose, action, success, startDate, endDate, ipAddress },
            resultCount: logs.rows.length
          });

          success(res, {
            logs: logs.rows,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: parseInt(total.rows[0].count),
              totalPages: Math.ceil(total.rows[0].count / limit)
            },
            filters: { phone, purpose, action, success, startDate, endDate, ipAddress },
            generatedBy: requestedBy
          }, 'OTP logs retrieved successfully');

        } catch (err) {
          logger.error('OTP Logs Error:', err);
          error(res, 'Failed to fetch OTP logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 OTP Status Check for specific phone
    [
      '/status/:phone',
      [
        query('purpose').optional().isString().withMessage('Purpose must be string')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const phone = normalizePhone(req.params.phone);
          const purpose = req.query.purpose || 'general';

          const result = await db.query(`
            SELECT id, attempts, expires_at, verified, created_at, purpose
            FROM otp_sessions 
            WHERE phone = $1 AND purpose = $2 AND verified = false
            ORDER BY created_at DESC 
            LIMIT 1
          `, [phone, purpose]);

          if (result.rows.length === 0) {
            return success(res, {
              phone,
              purpose,
              hasActiveOTP: false,
              canRequest: true
            }, 'No active OTP found');
          }

          const session = result.rows[0];
          const now = new Date();
          const expiresAt = new Date(session.expires_at);
          const isExpired = now > expiresAt;
          const remainingTime = Math.max(0, expiresAt.getTime() - now.getTime());

          success(res, {
            phone,
            purpose,
            hasActiveOTP: !isExpired,
            attemptsUsed: session.attempts,
            attemptsRemaining: Math.max(0, OTP_CONFIG.maxAttempts - session.attempts),
            expiresInSeconds: Math.floor(remainingTime / 1000),
            sessionId: session.id,
            createdAt: session.created_at
          }, 'OTP status retrieved');

        } catch (err) {
          logger.error('OTP Status Error:', err);
          error(res, 'Failed to get OTP status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  post: [
    // 🔐 Revoke OTP for User
    [
      '/revoke-otp',
      [
        ...adminOtpValidator,
        body('reason').notEmpty().withMessage('Reason is required for revocation')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { phone, purpose, reason } = req.body;
          const adminUid = req.user?.uid;
          const normalizedPhone = normalizePhone(phone);

          let whereClause = 'phone = $1 AND verified = false';
          const params = [normalizedPhone];

          if (purpose) {
            whereClause += ' AND purpose = $2';
            params.push(purpose);
          }

          // Revoke OTP sessions
          const result = await db.query(`
            UPDATE otp_sessions 
            SET verified = true, verified_at = NOW() 
            WHERE ${whereClause}
            RETURNING id, purpose
          `, params);

          const revokedCount = result.rowCount;

          // Log the revocation
          await logOTPActivity(normalizedPhone, purpose || 'all', 'admin_revoke', true, reason, req);

          await logAudit(req, 'otp-admin-revoked', {
            phone: normalizedPhone,
            purpose: purpose || 'all',
            revokedCount,
            reason
          });

          logger.info(`🔐 Admin revoked ${revokedCount} OTP(s) for ${normalizedPhone} - Reason: ${reason}`);

          success(res, {
            phone: normalizedPhone,
            purpose: purpose || 'all',
            revokedCount,
            reason,
            revokedBy: adminUid,
            timestamp: new Date().toISOString()
          }, `${revokedCount} OTP session(s) revoked successfully`);

        } catch (err) {
          logger.error('Revoke OTP Error:', err);
          error(res, 'Failed to revoke OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🧹 Cleanup OTP Logs
    [
      '/cleanup-logs',
      [
        body('olderThanDays').isInt({ min: 1, max: 365 }).withMessage('olderThanDays must be 1-365')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { olderThanDays } = req.body;
          const adminUid = req.user?.uid;

          const result = await db.query(
            `DELETE FROM otp_logs 
             WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'`
          );

          const deletedCount = result.rowCount;

          await logAudit(req, 'otp-logs-cleanup', {
            olderThanDays,
            deletedCount
          });

          logger.info(`🧹 Admin cleaned up ${deletedCount} OTP logs older than ${olderThanDays} days`);

          success(res, {
            deletedCount,
            olderThanDays,
            cleanedBy: adminUid,
            timestamp: new Date().toISOString()
          }, `Cleaned up ${deletedCount} old OTP logs successfully`);

        } catch (err) {
          logger.error('OTP Logs Cleanup Error:', err);
          error(res, 'Failed to cleanup logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // ⚙️ Update OTP Configuration
    [
      '/update-config',
      [
        body('expirationMinutes').optional().isInt({ min: 1, max: 60 }).withMessage('Expiration must be 1-60 minutes'),
        body('maxAttempts').optional().isInt({ min: 1, max: 10 }).withMessage('Max attempts must be 1-10'),
        body('dailyLimit').optional().isInt({ min: 1, max: 100 }).withMessage('Daily limit must be 1-100'),
        body('resendCooldownMinutes').optional().isInt({ min: 0, max: 10 }).withMessage('Cooldown must be 0-10 minutes')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { 
            expirationMinutes, 
            maxAttempts, 
            dailyLimit, 
            resendCooldownMinutes 
          } = req.body;
          
          const adminUid = req.user?.uid;
          const previousConfig = { ...OTP_CONFIG };
          const updates = {};

          if (expirationMinutes !== undefined) {
            OTP_CONFIG.expirationMinutes = expirationMinutes;
            updates.expirationMinutes = expirationMinutes;
          }

          if (maxAttempts !== undefined) {
            OTP_CONFIG.maxAttempts = maxAttempts;
            updates.maxAttempts = maxAttempts;
          }

          if (dailyLimit !== undefined) {
            OTP_CONFIG.dailyLimit = dailyLimit;
            updates.dailyLimit = dailyLimit;
          }

          if (resendCooldownMinutes !== undefined) {
            OTP_CONFIG.resendCooldownMinutes = resendCooldownMinutes;
            updates.resendCooldownMinutes = resendCooldownMinutes;
          }

          if (Object.keys(updates).length === 0) {
            return error(res, 'No valid configuration updates provided', HTTP_STATUS.BAD_REQUEST);
          }

          await logAudit(req, 'otp-config-updated', {
            previousConfig,
            updates,
            newConfig: OTP_CONFIG
          });

          logger.info(`⚙️ OTP configuration updated by admin ${adminUid}:`, updates);

          success(res, {
            previousConfig,
            updates,
            newConfig: OTP_CONFIG,
            updatedBy: adminUid,
            timestamp: new Date().toISOString()
          }, 'OTP configuration updated successfully');

        } catch (err) {
          logger.error('Update Config Error:', err);
          error(res, 'Failed to update configuration', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📨 Force Send OTP (Admin Override)
    [
      '/force-send-otp',
      [
        body('phone').notEmpty().withMessage('Phone number required'),
        body('purpose').optional().isString().withMessage('Purpose must be string'),
        body('reason').notEmpty().withMessage('Reason is required for force send'),
        body('bypassLimits').optional().isBoolean().withMessage('Bypass limits must be boolean')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { phone, purpose = 'admin_override', reason, bypassLimits = true } = req.body;
          const adminUid = req.user?.uid;
          const normalizedPhone = normalizePhone(phone);

          // Generate OTP directly (bypassing normal limits if requested)
          const otp = OTP_CONFIG.devMode ? '123456' : Math.floor(100000 + Math.random() * 900000).toString();
          const expiresAt = new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));

          // Store OTP
          const result = await db.query(`
            INSERT INTO otp_sessions (
              phone, otp, purpose, expires_at, 
              attempts, created_at, verified
            ) VALUES ($1, $2, $3, $4, 0, NOW(), false)
            RETURNING id
          `, [normalizedPhone, otp, purpose, expiresAt]);

          const sessionId = result.rows[0].id;

          // Log the admin action
          await logOTPActivity(normalizedPhone, purpose, 'admin_force_send', true, reason, req);

          await logAudit(req, 'otp-admin-force-send', {
            phone: normalizedPhone,
            purpose,
            reason,
            bypassLimits,
            sessionId
          });

          logger.info(`📨 Admin force-sent OTP for ${normalizedPhone} - Reason: ${reason}`);

          success(res, {
            phone: normalizedPhone,
            purpose,
            otpSent: true,
            sessionId,
            reason,
            bypassLimits,
            sentBy: adminUid,
            expiresInMinutes: OTP_CONFIG.expirationMinutes,
            // Only include OTP in development mode
            ...(OTP_CONFIG.devMode && { devOtp: otp }),
            timestamp: new Date().toISOString()
          }, 'OTP force-sent successfully by admin');

        } catch (err) {
          logger.error('Force Send OTP Error:', err);
          error(res, 'Failed to force send OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  delete: [
    // 🗑️ Bulk Delete OTP Sessions
    [
      '/bulk-delete-sessions',
      [
        body('phone').optional().isString().withMessage('Phone must be string'),
        body('purpose').optional().isString().withMessage('Purpose must be string'),
        body('olderThanHours').optional().isInt({ min: 1 }).withMessage('Hours must be positive integer'),
        body('reason').notEmpty().withMessage('Reason is required for bulk delete')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { phone, purpose, olderThanHours, reason } = req.body;
          const adminUid = req.user?.uid;

          let whereClause = 'WHERE 1=1';
          const params = [];
          let paramIndex = 1;

          if (phone) {
            const normalizedPhone = normalizePhone(phone);
            whereClause += ` AND phone = $${paramIndex}`;
            params.push(normalizedPhone);
            paramIndex++;
          }

          if (purpose) {
            whereClause += ` AND purpose = $${paramIndex}`;
            params.push(purpose);
            paramIndex++;
          }

          if (olderThanHours) {
            whereClause += ` AND created_at < NOW() - INTERVAL '${olderThanHours} hours'`;
          }

          const result = await db.query(`
            DELETE FROM otp_sessions 
            ${whereClause}
            RETURNING id, phone, purpose
          `, params);

          const deletedCount = result.rowCount;

          await logAudit(req, 'otp-bulk-delete', {
            filters: { phone, purpose, olderThanHours },
            deletedCount,
            reason
          });

          logger.info(`🗑️ Admin bulk deleted ${deletedCount} OTP sessions - Reason: ${reason}`);

          success(res, {
            deletedCount,
            filters: { phone, purpose, olderThanHours },
            reason,
            deletedBy: adminUid,
            timestamp: new Date().toISOString()
          }, `Bulk deleted ${deletedCount} OTP sessions successfully`);

        } catch (err) {
          logger.error('Bulk Delete Sessions Error:', err);
          error(res, 'Failed to bulk delete sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

export default router;