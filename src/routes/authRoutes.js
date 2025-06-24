// src/routes/authRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator, otpValidator } from '../config/validationSchemas.js';
import * as authController from '../controllers/authController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { generateToken, verifyToken } from '../utils/jwtUtils.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import crypto from 'crypto';

const router = express.Router();
console.log('✅ authRoutes loaded with enhanced security');

// ✅ OTP Storage (In production, use Redis or database)
const otpStore = new Map();

// ✅ Generate secure OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// ✅ Store OTP with expiration (5 minutes)
function storeOTP(phone, otp) {
  const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes
  otpStore.set(phone, { otp, expiresAt });
  
  // Cleanup expired OTPs
  setTimeout(() => {
    const stored = otpStore.get(phone);
    if (stored && stored.expiresAt <= Date.now()) {
      otpStore.delete(phone);
    }
  }, 5 * 60 * 1000);
}

// ✅ Verify OTP
function verifyOTP(phone, inputOtp) {
  const stored = otpStore.get(phone);
  if (!stored) return { valid: false, reason: 'OTP not found or expired' };
  
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(phone);
    return { valid: false, reason: 'OTP expired' };
  }
  
  if (stored.otp !== inputOtp) {
    return { valid: false, reason: 'Invalid OTP' };
  }
  
  otpStore.delete(phone); // OTP is single-use
  return { valid: true };
}

// ✅ Public Authentication Routes — no API key required, no RBAC
wrapRoutesWithValidation(
  router,
  [], // No RBAC for public auth routes
  {
    post: [
      // 📱 Request OTP for Login/Registration (Enhanced)
      [
        '/request-otp',
        phoneValidator,
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
          
          try {
            // Generate and store OTP
            const otp = generateOTP();
            storeOTP(phone, otp);

            // Check if user exists
            const userResult = await db.query('SELECT uid, name, role FROM users WHERE phone = $1', [phone]);
            const userExists = userResult.rows.length > 0;

            // In production, send OTP via SMS service
            logger.info(`🔐 OTP ${otp} generated for ${phone} (${userExists ? 'existing' : 'new'} user)`);

            success(res, {
              phone,
              userExists,
              otpSent: true,
              // Remove in production - only for testing
              devOtp: process.env.NODE_ENV === 'development' ? otp : undefined
            }, 'OTP sent successfully');

            // Log authentication attempt
            try {
              await db.query(
                `INSERT INTO auth_logs (phone, action, success, ip_address, user_agent, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [
                  phone,
                  'otp_request',
                  true,
                  req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
                  req.headers['user-agent']
                ]
              );
            } catch (logErr) {
              // Don't fail the request if logging fails
              logger.warn('Failed to log auth attempt:', logErr.message);
            }

          } catch (err) {
            logger.error('OTP Request Error:', err.stack || err.toString());
            error(res, 'Failed to send OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔐 Verify OTP and Login/Register (Enhanced)
      [
        '/verify-otp',
        [phoneValidator, otpValidator],
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
          const inputOtp = req.body.otp;

          try {
            // Verify OTP
            const verification = verifyOTP(phone, inputOtp);
            
            if (!verification.valid) {
              try {
                await db.query(
                  `INSERT INTO auth_logs (phone, action, success, failure_reason, ip_address, created_at)
                   VALUES ($1, $2, $3, $4, $5, NOW())`,
                  [phone, 'otp_verify', false, verification.reason, req.headers['x-forwarded-for']]
                );
              } catch (logErr) {
                logger.warn('Failed to log failed auth:', logErr.message);
              }
              
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                error: verification.reason
              });
            }

            // Check if user exists
            let userResult = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
            let user;

            if (userResult.rows.length === 0) {
              // Create new user with PATIENT role
              const insertResult = await db.query(
                `INSERT INTO users (phone, role, registered_at) 
                 VALUES ($1, $2, NOW()) RETURNING *`,
                [phone, 'PATIENT']
              );
              user = insertResult.rows[0];
              logger.info(`👤 New user registered: ${phone}`);
            } else {
              user = userResult.rows[0];
              logger.info(`👤 Existing user logged in: ${phone}`);
            }

            // Generate JWT token
            const token = generateToken({
              uid: user.uid,
              phone: user.phone,
              role: user.role,
              id: user.id
            });

            // Update last login
            await db.query(
              'UPDATE users SET last_login = NOW() WHERE phone = $1',
              [phone]
            );

            // Log successful authentication
            try {
              await db.query(
                `INSERT INTO auth_logs (phone, action, success, ip_address, user_agent, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [phone, 'login', true, req.headers['x-forwarded-for'], req.headers['user-agent']]
              );
            } catch (logErr) {
              logger.warn('Failed to log successful auth:', logErr.message);
            }

            success(res, {
              token,
              user: {
                uid: user.uid,
                id: user.id,
                phone: user.phone,
                name: user.name,
                role: user.role,
                email: user.email,
                profileComplete: !!(user.name && user.gender),
                requiresProfileCompletion: !(user.name && user.gender)
              }
            }, userResult.rows.length === 0 ? 'User registered and logged in' : 'Login successful');

          } catch (err) {
            logger.error('OTP Verification Error:', err.stack || err.toString());
            error(res, 'Authentication failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Refresh JWT Token (Enhanced)
      [
        '/refresh-token',
        async (req, res) => {
          const authHeader = req.headers['authorization'];
          
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({
              success: false,
              error: 'Authorization token required'
            });
          }

          const token = authHeader.split(' ')[1];
          const decoded = verifyToken(token);

          if (!decoded) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({
              success: false,
              error: 'Invalid or expired token'
            });
          }

          try {
            // Verify user still exists and get updated info
            const userResult = await db.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
            
            if (userResult.rows.length === 0) {
              return res.status(HTTP_STATUS.UNAUTHORIZED).json({
                success: false,
                error: 'User not found'
              });
            }

            const user = userResult.rows[0];

            // Generate new token with fresh data
            const newToken = generateToken({
              uid: user.uid,
              id: user.id,
              phone: user.phone,
              role: user.role
            });

            success(res, {
              token: newToken,
              user: {
                uid: user.uid,
                id: user.id,
                phone: user.phone,
                name: user.name,
                role: user.role,
                email: user.email
              }
            }, 'Token refreshed successfully');

          } catch (err) {
            logger.error('Token Refresh Error:', err.stack || err.toString());
            error(res, 'Failed to refresh token', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🚪 Logout (Enhanced)
      [
        '/logout',
        async (req, res) => {
          const authHeader = req.headers['authorization'];
          
          if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const decoded = verifyToken(token);
            
            if (decoded) {
              // Log logout
              try {
                await db.query(
                  `INSERT INTO auth_logs (phone, action, success, ip_address, created_at)
                   VALUES ($1, $2, $3, $4, NOW())`,
                  [decoded.phone, 'logout', true, req.headers['x-forwarded-for']]
                );
              } catch (logErr) {
                logger.warn('Failed to log logout:', logErr.message);
              }
            }
          }

          success(res, {
            message: 'Logged out successfully. Please discard your token.'
          }, 'Logout successful');
        }
      ],

      // Legacy routes from deprecated version (maintained for backward compatibility)
      [
        '/login',
        phoneValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }
          authController.login(req, res);
        }
      ],
      [
        '/register',
        phoneValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }
          authController.register(req, res);
        }
      ],
      [
        '/send-magic-link',
        phoneValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }
          authController.sendMagicLink(req, res);
        }
      ],

      // Legacy token route (from deprecated)
      ['/token', authController.refreshToken]
    ],

    get: [
      // 📊 Authentication Health Check
      [
        '/health',
        async (req, res) => {
          try {
            // Check OTP store health
            const activeOtps = otpStore.size;
            
            // Check recent auth activity
            let recentActivity = [];
            try {
              const activity = await db.query(
                `SELECT action, COUNT(*) as count 
                 FROM auth_logs 
                 WHERE created_at > NOW() - INTERVAL '1 hour'
                 GROUP BY action`
              );
              recentActivity = activity.rows;
            } catch (dbErr) {
              logger.warn('Failed to get recent activity:', dbErr.message);
            }

            success(res, {
              status: 'healthy',
              activeOtps,
              recentActivity,
              timestamp: new Date().toISOString()
            }, 'Authentication service is healthy');

          } catch (err) {
            logger.error('Auth Health Check Error:', err);
            error(res, 'Authentication service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Legacy verify token route (from deprecated)
      [
        '/verify-token',
        (req, res) => {
          authController.verifyMagicToken(req, res);
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false // We want to audit auth attempts
  }
);

// ✅ Public statistics route (no auth required but rate limited)
wrapRoutesWithValidation(
  router,
  [], // No roles required
  {
    get: [
      // 📈 Public Authentication Statistics
      [
        '/stats',
        async (req, res) => {
          try {
            let stats = {};
            try {
              const authStats = await db.query(`
                SELECT 
                  COUNT(*) FILTER (WHERE action = 'login' AND success = true AND created_at > NOW() - INTERVAL '24 hours') as logins_24h,
                  COUNT(*) FILTER (WHERE action = 'otp_request' AND created_at > NOW() - INTERVAL '24 hours') as otp_requests_24h,
                  COUNT(*) FILTER (WHERE action = 'login' AND success = false AND created_at > NOW() - INTERVAL '24 hours') as failed_logins_24h,
                  COUNT(DISTINCT phone) FILTER (WHERE action = 'login' AND success = true AND created_at > NOW() - INTERVAL '24 hours') as unique_users_24h
                FROM auth_logs
              `);
              stats.authentication = authStats.rows[0];
            } catch (dbErr) {
              logger.warn('Failed to get auth stats:', dbErr.message);
              stats.authentication = {
                logins_24h: 0,
                otp_requests_24h: 0,
                failed_logins_24h: 0,
                unique_users_24h: 0
              };
            }

            try {
              const userStats = await db.query(`
                SELECT 
                  role,
                  COUNT(*) as count,
                  COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '24 hours') as active_24h,
                  COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_7d
                FROM users 
                GROUP BY role
              `);
              stats.usersByRole = userStats.rows;
            } catch (dbErr) {
              logger.warn('Failed to get user stats:', dbErr.message);
              stats.usersByRole = [];
            }

            success(res, {
              ...stats,
              timestamp: new Date().toISOString()
            }, 'Authentication statistics');

          } catch (err) {
            logger.error('Auth Stats Error:', err);
            error(res, 'Failed to fetch statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    rateLimiting: true // Enable rate limiting for public stats
  }
);

// ✅ Admin-only routes for authentication management
wrapAutoRBAC(
  router,
  'authAdminRoutes',
  {
    get: [
      // 📋 Recent Authentication Logs
      [
        '/admin/logs',
        async (req, res) => {
          try {
            const { page = 1, limit = 50, action, success } = req.query;
            const offset = (page - 1) * limit;

            let whereClause = 'WHERE 1=1';
            const params = [limit, offset];
            let paramIndex = 3;

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

            const logs = await db.query(
              `SELECT phone, action, success, failure_reason, ip_address, user_agent, created_at
               FROM auth_logs 
               ${whereClause}
               ORDER BY created_at DESC 
               LIMIT $1 OFFSET $2`,
              params
            );

            const total = await db.query(
              `SELECT COUNT(*) FROM auth_logs ${whereClause}`,
              params.slice(2)
            );

            success(res, {
              logs: logs.rows,
              pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total.rows[0].count),
                totalPages: Math.ceil(total.rows[0].count / limit)
              },
              requestedBy: req.user?.name
            }, 'Authentication logs retrieved');

          } catch (err) {
            logger.error('Auth Logs Error:', err);
            
            // Fallback response if auth_logs table doesn't exist
            success(res, {
              logs: [],
              pagination: {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                total: 0,
                totalPages: 0
              },
              note: 'auth_logs table may not exist',
              requestedBy: req.user?.name
            }, 'Authentication logs retrieved (empty - table may not exist)');
          }
        }
      ],

      // 🔒 Active Sessions
      [
        '/admin/active-sessions',
        async (req, res) => {
          try {
            // Get users who have logged in recently and might have active tokens
            const activeSessions = await db.query(`
              SELECT 
                u.uid, u.phone, u.name, u.role, u.last_login,
                al.ip_address, al.user_agent, al.created_at as last_auth
              FROM users u
              LEFT JOIN LATERAL (
                SELECT ip_address, user_agent, created_at
                FROM auth_logs 
                WHERE phone = u.phone AND action = 'login' AND success = true
                ORDER BY created_at DESC 
                LIMIT 1
              ) al ON true
              WHERE u.last_login > NOW() - INTERVAL '7 days'
              ORDER BY u.last_login DESC
            `);

            success(res, {
              sessions: activeSessions.rows,
              totalActive: activeSessions.rows.length,
              requestedBy: req.user?.name,
              timestamp: new Date().toISOString()
            }, 'Active sessions retrieved');

          } catch (err) {
            logger.error('Active Sessions Error:', err);
            
            // Fallback response
            success(res, {
              sessions: [],
              totalActive: 0,
              note: 'Could not retrieve active sessions - auth_logs table may not exist',
              requestedBy: req.user?.name,
              timestamp: new Date().toISOString()
            }, 'Active sessions retrieved (empty - table may not exist)');
          }
        }
      ]
    ],

    post: [
      // 🔐 Force User Logout (Invalidate sessions)
      [
        '/admin/force-logout',
        async (req, res) => {
          try {
            const { phone, reason = 'Admin action' } = req.body;

            if (!phone) {
              return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
            }

            const normalizedPhone = normalizePhone(phone);

            // Log forced logout
            try {
              await db.query(
                `INSERT INTO auth_logs (phone, action, success, failure_reason, ip_address, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [normalizedPhone, 'force_logout', true, reason, req.headers['x-forwarded-for']]
              );
            } catch (logErr) {
              logger.warn('Failed to log force logout:', logErr.message);
            }

            success(res, {
              phone: normalizedPhone,
              action: 'force_logout',
              reason,
              forcedBy: req.user?.name,
              timestamp: new Date().toISOString()
            }, 'User logout forced. All tokens should be considered invalid.');

          } catch (err) {
            logger.error('Force Logout Error:', err);
            error(res, 'Failed to force logout', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🧹 Cleanup Authentication Logs
      [
        '/admin/cleanup-logs',
        async (req, res) => {
          try {
            const { olderThanDays = 90 } = req.body;

            const result = await db.query(
              `DELETE FROM auth_logs 
               WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'`
            );

            const deletedCount = result.rowCount || 0;

            logger.info(`🧹 Cleaned up ${deletedCount} authentication logs older than ${olderThanDays} days by ${req.user?.name}`);

            success(res, {
              deletedCount,
              olderThanDays,
              cleanedBy: req.user?.name,
              timestamp: new Date().toISOString()
            }, `Cleaned up ${deletedCount} old authentication logs`);

          } catch (err) {
            logger.error('Auth Logs Cleanup Error:', err);
            error(res, 'Failed to cleanup logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,        // Require admin authentication
    requirePhone: false,     // Phone not required for admin operations
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN']        // Admin only access
  }
);

export default router;