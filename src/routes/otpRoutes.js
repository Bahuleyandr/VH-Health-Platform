// src/routes/otpRoutes.js - ENHANCED VERSION WITH FULL RBAC
import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator, otpValidator } from '../config/validationSchemas.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutesWithValidation, wrapAutoRBAC } from '../config/routeWrapper.js';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { logAudit } from '../utils/logAudit.js';
import crypto from 'crypto';
import { body, query } from 'express-validator';

const router = express.Router();
logger.info('✅ Enhanced otpRoutes loaded with full RBAC protection and security features');

// ✅ OTP Configuration
const OTP_CONFIG = {
  length: 6,
  expirationMinutes: parseInt(process.env.OTP_EXPIRATION_MINUTES) || 5,
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS) || 3,
  resendCooldownMinutes: parseInt(process.env.OTP_RESEND_COOLDOWN) || 1,
  dailyLimit: parseInt(process.env.OTP_DAILY_LIMIT) || 10,
  devMode: process.env.NODE_ENV === 'development'
};

// ✅ Input validation schemas
const otpRequestValidator = [
  ...phoneValidator,
  body('purpose').optional().isIn(['login', 'register', 'reset_password', 'verify_phone', 'general']).withMessage('Invalid OTP purpose'),
  body('user_id').optional().isInt({ min: 1 }).withMessage('Invalid user ID')
];

const otpVerifyValidator = [
  ...phoneValidator,
  ...otpValidator,
  body('purpose').optional().isIn(['login', 'register', 'reset_password', 'verify_phone', 'general']).withMessage('Invalid OTP purpose')
];

const adminOtpValidator = [
  body('phone').notEmpty().withMessage('Phone number required'),
  body('purpose').optional().isString().withMessage('Purpose must be string'),
  body('reason').optional().isString().withMessage('Reason must be string')
];

// ✅ Generate secure OTP
function generateOTP(length = OTP_CONFIG.length) {
  // In development mode, return fixed OTP for testing
  if (OTP_CONFIG.devMode) {
    return '123456';
  }
  
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return crypto.randomInt(min, max).toString();
}

// ✅ Store OTP in database
async function storeOTP(phone, purpose = 'general', userId = null) {
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));
  
  try {
    // Delete any existing OTP for the same phone/purpose
    await pool.query(
      'DELETE FROM otp_sessions WHERE phone = $1 AND purpose = $2',
      [phone, purpose]
    );
    
    // Insert new OTP
    const result = await pool.query(`
      INSERT INTO otp_sessions (
        phone, otp, purpose, user_id, expires_at, 
        attempts, created_at, verified
      ) VALUES ($1, $2, $3, $4, $5, 0, NOW(), false)
      RETURNING id, expires_at
    `, [phone, otp, purpose, userId, expiresAt]);
    
    return { 
      otp, 
      expiresAt, 
      sessionId: result.rows[0].id 
    };
  } catch (dbError) {
    logger.error('Store OTP Error:', dbError);
    throw new Error('Failed to store OTP');
  }
}

// ✅ Verify OTP from database
async function verifyOTP(phone, inputOtp, purpose = 'general') {
  try {
    // Get OTP session
    const result = await pool.query(`
      SELECT id, otp, attempts, expires_at, verified, user_id
      FROM otp_sessions 
      WHERE phone = $1 AND purpose = $2 AND verified = false
      ORDER BY created_at DESC 
      LIMIT 1
    `, [phone, purpose]);
    
    if (result.rows.length === 0) {
      return { valid: false, reason: 'OTP not found or expired' };
    }
    
    const session = result.rows[0];
    
    // Check expiration
    if (new Date() > new Date(session.expires_at)) {
      await pool.query('UPDATE otp_sessions SET verified = true WHERE id = $1', [session.id]);
      return { valid: false, reason: 'OTP expired' };
    }
    
    // Check if already verified
    if (session.verified) {
      return { valid: false, reason: 'OTP already used' };
    }
    
    // Increment attempts
    const newAttempts = session.attempts + 1;
    await pool.query(
      'UPDATE otp_sessions SET attempts = $1 WHERE id = $2',
      [newAttempts, session.id]
    );
    
    // Check max attempts
    if (newAttempts > OTP_CONFIG.maxAttempts) {
      await pool.query('UPDATE otp_sessions SET verified = true WHERE id = $1', [session.id]);
      return { valid: false, reason: 'Too many attempts' };
    }
    
    // Verify OTP
    if (session.otp !== inputOtp) {
      return { 
        valid: false, 
        reason: 'Invalid OTP', 
        attemptsLeft: OTP_CONFIG.maxAttempts - newAttempts 
      };
    }
    
    // Mark as verified
    await pool.query(
      'UPDATE otp_sessions SET verified = true, verified_at = NOW() WHERE id = $1',
      [session.id]
    );
    
    return { 
      valid: true, 
      sessionId: session.id,
      userId: session.user_id
    };
  } catch (dbError) {
    logger.error('Verify OTP Error:', dbError);
    throw new Error('Failed to verify OTP');
  }
}

// ✅ Check daily limit
async function checkDailyLimit(phone) {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count
      FROM otp_logs 
      WHERE phone = $1 
        AND action = 'request' 
        AND success = true 
        AND created_at > CURRENT_DATE
    `, [phone]);
    
    return parseInt(result.rows[0].count) < OTP_CONFIG.dailyLimit;
  } catch (dbError) {
    logger.error('Daily limit check error:', dbError);
    return false; // Fail safe
  }
}

// ✅ Check resend cooldown
async function checkResendCooldown(phone, purpose = 'general') {
  try {
    const result = await pool.query(`
      SELECT created_at
      FROM otp_sessions 
      WHERE phone = $1 AND purpose = $2
      ORDER BY created_at DESC 
      LIMIT 1
    `, [phone, purpose]);
    
    if (result.rows.length === 0) return true;
    
    const lastCreated = new Date(result.rows[0].created_at);
    const cooldownMs = OTP_CONFIG.resendCooldownMinutes * 60 * 1000;
    const timeSinceCreation = Date.now() - lastCreated.getTime();
    
    return timeSinceCreation >= cooldownMs;
  } catch (dbError) {
    logger.error('Resend cooldown check error:', dbError);
    return false; // Fail safe
  }
}

// ✅ Log OTP activity
async function logOTPActivity(phone, purpose, action, success, failureReason = null, req) {
  try {
    await pool.query(`
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
    logger.error('OTP log error:', dbError);
    // Don't throw - logging failure shouldn't break OTP flow
  }
}

// ✅ PUBLIC OTP ROUTES - No authentication required
wrapRoutesWithValidation(
  router,
  [], // No roles required - public
  {
    post: [
      // 📱 Request OTP
      [
        '/request-otp',
        otpRequestValidator,
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
            const purpose = req.body.purpose || 'general';
            const userId = req.body.user_id || null;
            
            // Check daily limit
            const dailyLimitOk = await checkDailyLimit(phone);
            if (!dailyLimitOk) {
              await logOTPActivity(phone, purpose, 'request', false, 'daily_limit_exceeded', req);
              return error(res, 'Daily OTP limit exceeded. Try again tomorrow.', HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Check resend cooldown
            const cooldownOk = await checkResendCooldown(phone, purpose);
            if (!cooldownOk) {
              await logOTPActivity(phone, purpose, 'request', false, 'resend_cooldown', req);
              return error(res, `Please wait ${OTP_CONFIG.resendCooldownMinutes} minute(s) before requesting another OTP`, HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Generate and store OTP
            const { otp, expiresAt, sessionId } = await storeOTP(phone, purpose, userId);

            // Log successful request
            await logOTPActivity(phone, purpose, 'request', true, null, req);

            // In production, integrate with SMS service here
            logger.info(`📱 OTP ${otp} generated for ${phone} (${purpose}) - Session: ${sessionId}`);

            // Simulate SMS sending delay in development
            if (OTP_CONFIG.devMode) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            success(res, {
              phone,
              purpose,
              otpSent: true,
              sessionId,
              expiresInMinutes: OTP_CONFIG.expirationMinutes,
              attemptsAllowed: OTP_CONFIG.maxAttempts,
              // Only include OTP in development mode
              ...(OTP_CONFIG.devMode && { devOtp: otp })
            }, `OTP sent successfully for ${purpose}`);

          } catch (err) {
            logger.error('OTP Request Error:', err.stack || err.toString());
            await logOTPActivity(
              req.body.phone, 
              req.body.purpose || 'general', 
              'request', 
              false, 
              'system_error', 
              req
            );
            error(res, 'Failed to send OTP. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // ✅ Verify OTP
      [
        '/verify-otp',
        otpVerifyValidator,
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
            const inputOtp = req.body.otp;
            const purpose = req.body.purpose || 'general';

            // Verify OTP
            const verification = await verifyOTP(phone, inputOtp, purpose);
            
            // Log verification attempt
            await logOTPActivity(
              phone, purpose, 'verify', verification.valid,
              verification.valid ? null : verification.reason, req
            );

            if (!verification.valid) {
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                error: verification.reason,
                attemptsLeft: verification.attemptsLeft
              });
            }

            // Log audit for successful verification
            await logAudit(req, 'otp-verified', {
              phone,
              purpose,
              sessionId: verification.sessionId
            });

            logger.info(`✅ OTP verified for ${phone} (${purpose})`);

            success(res, {
              phone,
              purpose,
              verified: true,
              sessionId: verification.sessionId,
              userId: verification.userId,
              verifiedAt: new Date().toISOString()
            }, RESPONSE_MESSAGES.OTP_VERIFIED);

          } catch (err) {
            logger.error('OTP Verification Error:', err.stack || err.toString());
            await logOTPActivity(
              req.body.phone, 
              req.body.purpose || 'general', 
              'verify', 
              false, 
              'system_error', 
              req
            );
            error(res, 'OTP verification failed. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Resend OTP
      [
        '/resend-otp',
        otpRequestValidator,
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
            const purpose = req.body.purpose || 'general';

            // Check if there's an existing unverified OTP
            const existingResult = await pool.query(`
              SELECT id FROM otp_sessions 
              WHERE phone = $1 AND purpose = $2 AND verified = false 
                AND expires_at > NOW()
              ORDER BY created_at DESC 
              LIMIT 1
            `, [phone, purpose]);
            
            if (existingResult.rows.length === 0) {
              await logOTPActivity(phone, purpose, 'resend', false, 'no_active_otp', req);
              return error(res, 'No active OTP found to resend. Please request a new OTP.', HTTP_STATUS.BAD_REQUEST);
            }

            // Check resend cooldown
            const cooldownOk = await checkResendCooldown(phone, purpose);
            if (!cooldownOk) {
              await logOTPActivity(phone, purpose, 'resend', false, 'resend_cooldown', req);
              return error(res, `Please wait ${OTP_CONFIG.resendCooldownMinutes} minute(s) before resending`, HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Check daily limit
            const dailyLimitOk = await checkDailyLimit(phone);
            if (!dailyLimitOk) {
              await logOTPActivity(phone, purpose, 'resend', false, 'daily_limit_exceeded', req);
              return error(res, 'Daily OTP limit exceeded', HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Generate new OTP (this will replace the existing one)
            const { otp, expiresAt, sessionId } = await storeOTP(phone, purpose);

            // Log successful resend
            await logOTPActivity(phone, purpose, 'resend', true, null, req);

            logger.info(`🔄 OTP resent for ${phone} (${purpose}) - Session: ${sessionId}`);

            success(res, {
              phone,
              purpose,
              otpResent: true,
              sessionId,
              expiresInMinutes: OTP_CONFIG.expirationMinutes,
              // Only include OTP in development mode
              ...(OTP_CONFIG.devMode && { devOtp: otp })
            }, 'OTP resent successfully');

          } catch (err) {
            logger.error('OTP Resend Error:', err.stack || err.toString());
            await logOTPActivity(
              req.body.phone, 
              req.body.purpose || 'general', 
              'resend', 
              false, 
              'system_error', 
              req
            );
            error(res, 'Failed to resend OTP. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    get: [
      // 📊 OTP Status Check
      [
        '/status',
        query('phone').notEmpty().withMessage('Phone number required'),
        query('purpose').optional().isString().withMessage('Purpose must be string'),
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const phone = normalizePhone(req.query.phone);
            const purpose = req.query.purpose || 'general';

            const result = await pool.query(`
              SELECT id, attempts, expires_at, verified, created_at
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
            const canResend = await checkResendCooldown(phone, purpose);

            success(res, {
              phone,
              purpose,
              hasActiveOTP: !isExpired,
              attemptsUsed: session.attempts,
              attemptsRemaining: Math.max(0, OTP_CONFIG.maxAttempts - session.attempts),
              expiresInSeconds: Math.floor(remainingTime / 1000),
              canResend: canResend && !isExpired,
              sessionId: session.id
            }, 'OTP status retrieved');

          } catch (err) {
            logger.error('OTP Status Error:', err);
            error(res, 'Failed to get OTP status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🏥 OTP Service Health Check
      [
        '/health',
        async (req, res) => {
          try {
            // Get service statistics
            const [activeOTPs, recentStats, dailyStats] = await Promise.all([
              // Active OTP sessions
              pool.query(`
                SELECT COUNT(*) as count 
                FROM otp_sessions 
                WHERE verified = false AND expires_at > NOW()
              `),
              
              // Recent activity (last hour)
              pool.query(`
                SELECT 
                  purpose,
                  action,
                  COUNT(*) as count,
                  COUNT(*) FILTER (WHERE success = true) as successful,
                  COUNT(*) FILTER (WHERE success = false) as failed
                FROM otp_logs 
                WHERE created_at > NOW() - INTERVAL '1 hour'
                GROUP BY purpose, action
              `),
              
              // Daily statistics
              pool.query(`
                SELECT COUNT(*) as total_today
                FROM otp_logs 
                WHERE created_at > CURRENT_DATE AND action = 'request' AND success = true
              `)
            ]);

            success(res, {
              status: 'healthy',
              activeOTPs: parseInt(activeOTPs.rows[0].count),
              dailyRequests: parseInt(dailyStats.rows[0].total_today),
              recentActivity: recentStats.rows,
              config: {
                otpLength: OTP_CONFIG.length,
                expirationMinutes: OTP_CONFIG.expirationMinutes,
                maxAttempts: OTP_CONFIG.maxAttempts,
                dailyLimit: OTP_CONFIG.dailyLimit,
                resendCooldownMinutes: OTP_CONFIG.resendCooldownMinutes
              },
              timestamp: new Date().toISOString()
            }, 'OTP service is healthy');

          } catch (err) {
            logger.error('OTP Health Check Error:', err);
            // Graceful fallback
            success(res, {
              status: 'degraded',
              message: 'OTP service temporarily unavailable',
              timestamp: new Date().toISOString()
            }, 'OTP service status check');
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// ✅ ADMIN ROUTES - Full RBAC protection
wrapAutoRBAC(router, 'ALL', {
  get: [
    // 📋 OTP Usage Analytics
    [
      '/admin/analytics',
      query('startDate').optional().isISO8601().withMessage('Invalid start date'),
      query('endDate').optional().isISO8601().withMessage('Invalid end date'),
      query('purpose').optional().isString().withMessage('Purpose must be string'),
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
            pool.query(`
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
            pool.query(`
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
            pool.query(`
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
      '/admin/security-alerts',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid;

          const [suspiciousActivity, failurePatterns, ipAnalysis] = await Promise.all([
            // Unusual OTP activity patterns
            pool.query(`
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
            pool.query(`
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
            pool.query(`
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
      '/admin/active-sessions',
      query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be 1-500'),
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

          const result = await pool.query(`
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
      '/admin/logs',
      query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
      query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be 1-500'),
      query('phone').optional().isString().withMessage('Phone must be string'),
      query('purpose').optional().isString().withMessage('Purpose must be string'),
      query('action').optional().isIn(['request', 'verify', 'resend']).withMessage('Invalid action'),
      query('success').optional().isIn(['true', 'false']).withMessage('Success must be true or false'),
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
            pool.query(`
              SELECT 
                id, phone, purpose, action, success, failure_reason,
                ip_address, user_agent, created_at, created_by
              FROM otp_logs 
              ${whereClause}
              ORDER BY created_at DESC
              LIMIT $1 OFFSET $2
            `, params),

            pool.query(
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
    ]
  ],

  post: [
    // 🔐 Revoke OTP for User
    [
      '/admin/revoke-otp',
      adminOtpValidator,
      body('reason').notEmpty().withMessage('Reason is required for revocation'),
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
          const result = await pool.query(`
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
      '/admin/cleanup-logs',
      body('olderThanDays').isInt({ min: 1, max: 365 }).withMessage('olderThanDays must be 1-365'),
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

          const result = await pool.query(
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
      '/admin/update-config',
      body('expirationMinutes').optional().isInt({ min: 1, max: 60 }).withMessage('Expiration must be 1-60 minutes'),
      body('maxAttempts').optional().isInt({ min: 1, max: 10 }).withMessage('Max attempts must be 1-10'),
      body('dailyLimit').optional().isInt({ min: 1, max: 100 }).withMessage('Daily limit must be 1-100'),
      body('resendCooldownMinutes').optional().isInt({ min: 0, max: 10 }).withMessage('Cooldown must be 0-10 minutes'),
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
    ]
  ]
});

// ✅ DEVELOPMENT ROUTES - Only available in dev/test environments
if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
  wrapRoutesWithValidation(
    router,
    [], // Public in dev/test
    {
      post: [
        // 🧪 Generate Test OTP (Dev/Test Only)
        [
          '/dev/generate-test-otp',
          body('phone').notEmpty().withMessage('Phone required'),
          body('purpose').optional().isString().withMessage('Purpose must be string'),
          async (req, res) => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                errors: errors.array(),
                message: RESPONSE_MESSAGES.VALIDATION_FAILED
              });
            }

            try {
              const { phone, purpose = 'test' } = req.body;
              const normalizedPhone = normalizePhone(phone);
              
              const { otp, expiresAt, sessionId } = await storeOTP(normalizedPhone, purpose);

              success(res, {
                phone: normalizedPhone,
                purpose,
                otp, // Only in dev/test
                sessionId,
                expiresAt: new Date(expiresAt).toISOString(),
                warning: 'This endpoint is only available in development/test environments'
              }, 'Test OTP generated successfully');

            } catch (err) {
              logger.error('Test OTP Generation Error:', err);
              error(res, 'Failed to generate test OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
          }
        ]
      ],

      delete: [
        // 🧪 Clear All OTPs (Dev/Test Only)
        [
          '/dev/clear-all',
          async (req, res) => {
            try {
              const [sessionsResult, logsResult] = await Promise.all([
                pool.query('DELETE FROM otp_sessions RETURNING COUNT(*)'),
                pool.query('DELETE FROM otp_logs RETURNING COUNT(*)')
              ]);

              const clearedSessions = sessionsResult.rowCount || 0;
              const clearedLogs = logsResult.rowCount || 0;

              success(res, {
                clearedSessions,
                clearedLogs,
                warning: 'This endpoint is only available in development/test environments'
              }, 'All OTP data cleared successfully');

            } catch (err) {
              logger.error('Clear All OTPs Error:', err);
              error(res, 'Failed to clear OTP data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
          }
        ]
      ]
    },
    {
      requireUID: false,
      requirePhone: false,
      skipRBAC: true
    }
  );
}

export default router;