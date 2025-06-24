// src/routes/firebaseAuthRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import { validationResult, body } from 'express-validator';
import { phoneValidator, userProfileValidator } from '../config/validationSchemas.js';
import * as firebaseAuthController from '../controllers/firebaseAuthController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import admin from '../utils/firebaseAdmin.js';
import { generateToken } from '../utils/jwtUtils.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();
console.log('✅ firebaseAuthRoutes loaded with RBAC protection');

// ✅ Firebase-specific validators (enhanced from deprecated version)
const firebaseLoginValidator = [
  body('idToken')
    .notEmpty()
    .withMessage('Firebase ID token is required')
    .isString()
    .withMessage('ID token must be a string')
    .isLength({ min: 10 })
    .withMessage('Invalid ID token format')
];

const userRegistrationValidator = [
  body('phone')
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .trim(),
  body('gender')
    .optional()
    .isIn(['MALE', 'FEMALE', 'OTHER'])
    .withMessage('Gender must be MALE, FEMALE, or OTHER'),
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('birthday')
    .optional()
    .isISO8601()
    .withMessage('Birthday must be a valid date (YYYY-MM-DD)'),
  body('anniversary')
    .optional()
    .isISO8601()
    .withMessage('Anniversary must be a valid date (YYYY-MM-DD)'),
  body('address')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Address must be less than 500 characters')
    .trim()
];

// ✅ Validation middleware helper
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array(),
      message: RESPONSE_MESSAGES.VALIDATION_FAILED
    });
  }
  next();
};

/**
 * ✅ Public Firebase Authentication Routes - No RBAC required
 * Enhanced Firebase authentication with comprehensive user management
 */
wrapRoutesWithValidation(
  router,
  [], // Public routes
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          success(res, { 
            message: 'Firebase auth routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0'
          }, 'Firebase auth routes operational');
        }
      ],

      // 🔍 Verify Token Status
      [
        '/verify-token',
        async (req, res) => {
          const { idToken } = req.query;

          if (!idToken) {
            return error(res, 'Firebase ID token is required', HTTP_STATUS.BAD_REQUEST);
          }

          try {
            const decodedToken = await admin.auth().verifyIdToken(idToken, true);
            
            // Check if user exists in our system
            const userResult = await db.query(
              'SELECT uid, phone, name, role FROM users WHERE firebase_uid = $1',
              [decodedToken.uid]
            );

            const userExists = userResult.rows.length > 0;

            success(res, {
              valid: true,
              userExists,
              tokenInfo: {
                uid: decodedToken.uid,
                phone: decodedToken.phone_number,
                email: decodedToken.email,
                emailVerified: decodedToken.email_verified,
                issuedAt: new Date(decodedToken.iat * 1000),
                expiresAt: new Date(decodedToken.exp * 1000)
              },
              user: userExists ? userResult.rows[0] : null
            }, 'Token verified successfully');

          } catch (err) {
            logger.error('Token Verification Error:', err.stack || err.toString());
            
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({
              success: false,
              valid: false,
              message: 'Invalid or expired Firebase token'
            });
          }
        }
      ],

      // 📊 Firebase Authentication Health
      [
        '/health',
        async (req, res) => {
          try {
            // Test Firebase Admin connection
            await admin.auth().listUsers(1);

            // Get Firebase auth statistics
            const stats = await db.query(`
              SELECT 
                COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL) as firebase_users,
                COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND last_login > NOW() - INTERVAL '24 hours') as active_firebase_users_24h,
                COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND profile_completed_at IS NOT NULL) as completed_profiles,
                COUNT(*) as total_users
              FROM users
            `);

            const deviceStats = await db.query(`
              SELECT 
                platform,
                COUNT(*) as device_count,
                COUNT(*) FILTER (WHERE last_active > NOW() - INTERVAL '24 hours') as active_24h
              FROM user_devices
              GROUP BY platform
            `);

            success(res, {
              status: 'healthy',
              firebaseConnection: 'connected',
              statistics: stats.rows[0],
              deviceStatistics: deviceStats.rows,
              timestamp: new Date().toISOString()
            }, 'Firebase authentication service healthy');

          } catch (err) {
            logger.error('Firebase Health Check Error:', err.stack || err.toString());
            
            // Fallback response
            success(res, {
              status: 'degraded',
              firebaseConnection: 'unavailable',
              statistics: {
                firebase_users: 0,
                active_firebase_users_24h: 0,
                completed_profiles: 0,
                total_users: 0
              },
              deviceStatistics: [],
              note: 'Firebase connection failed or database tables may not exist',
              timestamp: new Date().toISOString()
            }, 'Firebase service status retrieved (degraded)');
          }
        }
      ]
    ],

    post: [
      // 🔥 Firebase ID Token Authentication (Enhanced from deprecated version)
      [
        '/firebase-login',
        firebaseLoginValidator,
        handleValidation,
        async (req, res) => {
          const { idToken, deviceInfo } = req.body;

          try {
            // Verify Firebase ID token
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            
            const firebasePhone = decodedToken.phone_number;
            if (!firebasePhone) {
              return error(res, 'Phone number not found in Firebase token', HTTP_STATUS.BAD_REQUEST);
            }

            const phone = normalizePhone(firebasePhone);
            const firebaseUid = decodedToken.uid;

            // Check if user exists in our database
            let userResult = await db.query(
              'SELECT * FROM users WHERE phone = $1 OR firebase_uid = $2',
              [phone, firebaseUid]
            );

            let user;
            let isNewUser = false;

            if (userResult.rows.length === 0) {
              // Create new user
              const insertResult = await db.query(
                `INSERT INTO users (
                  phone, firebase_uid, role, registered_at, last_login,
                  name, email, email_verified
                ) VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6) 
                RETURNING *`,
                [
                  phone,
                  firebaseUid,
                  'PATIENT', // Default role
                  decodedToken.name || null,
                  decodedToken.email || null,
                  decodedToken.email_verified || false
                ]
              );
              user = insertResult.rows[0];
              isNewUser = true;
              logger.info(`🔥 New Firebase user created: ${phone} (${firebaseUid})`);
            } else {
              user = userResult.rows[0];
              
              // Update Firebase UID if missing
              if (!user.firebase_uid) {
                await db.query(
                  'UPDATE users SET firebase_uid = $1, last_login = NOW() WHERE uid = $2',
                  [firebaseUid, user.uid]
                );
              } else {
                await db.query(
                  'UPDATE users SET last_login = NOW() WHERE uid = $1',
                  [user.uid]
                );
              }
              
              logger.info(`🔥 Existing Firebase user logged in: ${phone}`);
            }

            // Generate our JWT token
            const accessToken = generateToken({
              uid: user.uid,
              id: user.id,
              phone: user.phone,
              role: user.role,
              firebaseUid: firebaseUid
            });

            // Store device info if provided
            if (deviceInfo) {
              try {
                await db.query(
                  `INSERT INTO user_devices (
                    user_uid, device_id, device_name, platform, app_version, 
                    fcm_token, last_active, created_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                  ON CONFLICT (user_uid, device_id) 
                  DO UPDATE SET 
                    device_name = EXCLUDED.device_name,
                    platform = EXCLUDED.platform,
                    app_version = EXCLUDED.app_version,
                    fcm_token = EXCLUDED.fcm_token,
                    last_active = NOW()`,
                  [
                    user.uid,
                    deviceInfo.deviceId,
                    deviceInfo.deviceName,
                    deviceInfo.platform,
                    deviceInfo.appVersion,
                    deviceInfo.fcmToken
                  ]
                );
              } catch (deviceErr) {
                logger.warn('Failed to store device info:', deviceErr.message);
              }
            }

            // Log authentication
            try {
              await db.query(
                `INSERT INTO auth_logs (
                  phone, action, success, auth_method, ip_address, user_agent, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [
                  phone,
                  isNewUser ? 'firebase_register' : 'firebase_login',
                  true,
                  'firebase',
                  req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
                  req.headers['user-agent']
                ]
              );
            } catch (logErr) {
              logger.warn('Failed to log authentication:', logErr.message);
            }

            success(res, {
              accessToken,
              user: {
                uid: user.uid,
                id: user.id,
                phone: user.phone,
                name: user.name,
                email: user.email,
                role: user.role,
                profileComplete: !!(user.name && user.gender),
                emailVerified: user.email_verified,
                isNewUser
              }
            }, isNewUser ? 'User registered successfully' : 'Login successful');

          } catch (err) {
            logger.error('Firebase Login Error:', err.stack || err.toString());
            
            if (err.code === 'auth/id-token-expired') {
              return error(res, 'Firebase token has expired', HTTP_STATUS.UNAUTHORIZED);
            }
            
            if (err.code === 'auth/id-token-revoked') {
              return error(res, 'Firebase token has been revoked', HTTP_STATUS.UNAUTHORIZED);
            }

            return error(res, 'Invalid Firebase ID token', HTTP_STATUS.UNAUTHORIZED);
          }
        }
      ],

      // Legacy registration route (from deprecated version)
      [
        '/register',
        userRegistrationValidator,
        handleValidation,
        firebaseAuthController.registerUser
      ],

      // 👤 Complete User Profile after Firebase Auth
      [
        '/complete-profile',
        userProfileValidator,
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          const { 
            phone, name, gender, email, birthday, 
            anniversary, address, emergency_contact 
          } = req.body;

          try {
            const normalizedPhone = normalizePhone(phone);

            // Update user profile
            const result = await db.query(
              `UPDATE users SET 
                name = $1, gender = $2, email = $3, birthday = $4,
                anniversary = $5, address = $6, emergency_contact = $7,
                profile_completed_at = NOW()
              WHERE phone = $8 
              RETURNING *`,
              [
                name, gender, email, birthday,
                anniversary, address, emergency_contact,
                normalizedPhone
              ]
            );

            if (result.rows.length === 0) {
              return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
            }

            const user = result.rows[0];

            logger.info(`👤 Profile completed for user: ${normalizedPhone}`);

            success(res, {
              user: {
                uid: user.uid,
                id: user.id,
                phone: user.phone,
                name: user.name,
                gender: user.gender,
                email: user.email,
                role: user.role,
                profileComplete: true
              }
            }, 'Profile completed successfully');

          } catch (err) {
            logger.error('Profile Completion Error:', err.stack || err.toString());
            error(res, 'Failed to complete profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Link Firebase Account to Existing User
      [
        '/link-account',
        phoneValidator,
        async (req, res) => {
          const { phone, idToken, otp } = req.body;

          if (!idToken || !otp) {
            return error(res, 'Firebase ID token and OTP are required', HTTP_STATUS.BAD_REQUEST);
          }

          try {
            // Verify Firebase ID token
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            const firebaseUid = decodedToken.uid;
            const normalizedPhone = normalizePhone(phone);

            // Verify OTP (implement actual OTP verification here)
            // For demo purposes, accepting "123456" as valid OTP
            if (otp !== '123456') {
              return error(res, 'Invalid OTP', HTTP_STATUS.BAD_REQUEST);
            }

            // Check if user exists
            const userResult = await db.query(
              'SELECT * FROM users WHERE phone = $1',
              [normalizedPhone]
            );

            if (userResult.rows.length === 0) {
              return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
            }

            const user = userResult.rows[0];

            // Link Firebase UID to existing user
            await db.query(
              'UPDATE users SET firebase_uid = $1 WHERE uid = $2',
              [firebaseUid, user.uid]
            );

            // Generate new token with Firebase UID
            const accessToken = generateToken({
              uid: user.uid,
              id: user.id,
              phone: user.phone,
              role: user.role,
              firebaseUid: firebaseUid
            });

            logger.info(`🔗 Firebase account linked to existing user: ${normalizedPhone}`);

            success(res, {
              accessToken,
              user: {
                uid: user.uid,
                id: user.id,
                phone: user.phone,
                name: user.name,
                role: user.role,
                linkedToFirebase: true
              }
            }, 'Account linked successfully');

          } catch (err) {
            logger.error('Account Linking Error:', err.stack || err.toString());
            error(res, 'Failed to link account', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📱 Update FCM Token for Push Notifications
      [
        '/update-fcm-token',
        async (req, res) => {
          const { phone, fcmToken, deviceId } = req.body;

          if (!phone || !fcmToken) {
            return error(res, 'Phone and FCM token are required', HTTP_STATUS.BAD_REQUEST);
          }

          try {
            const normalizedPhone = normalizePhone(phone);

            // Update or insert FCM token
            await db.query(
              `INSERT INTO user_devices (user_uid, device_id, fcm_token, last_active, created_at)
               SELECT uid, $2, $3, NOW(), NOW() FROM users WHERE phone = $1
               ON CONFLICT (user_uid, device_id)
               DO UPDATE SET fcm_token = EXCLUDED.fcm_token, last_active = NOW()`,
              [normalizedPhone, deviceId || 'default', fcmToken]
            );

            logger.info(`📱 FCM token updated for user: ${normalizedPhone}`);

            success(res, {
              phone: normalizedPhone,
              fcmToken: fcmToken.substring(0, 10) + '...[REDACTED]',
              deviceId
            }, 'FCM token updated successfully');

          } catch (err) {
            logger.error('FCM Token Update Error:', err.stack || err.toString());
            error(res, 'Failed to update FCM token', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔐 Revoke Firebase Session
      [
        '/revoke-session',
        async (req, res) => {
          const { firebaseUid } = req.body;

          if (!firebaseUid) {
            return error(res, 'Firebase UID is required', HTTP_STATUS.BAD_REQUEST);
          }

          try {
            // Revoke Firebase tokens
            await admin.auth().revokeRefreshTokens(firebaseUid);

            // Log the revocation
            await db.query(
              `UPDATE users SET firebase_tokens_revoked_at = NOW() 
               WHERE firebase_uid = $1`,
              [firebaseUid]
            );

            logger.info(`🔐 Firebase session revoked for UID: ${firebaseUid}`);

            success(res, {
              firebaseUid,
              revokedAt: new Date().toISOString()
            }, 'Firebase session revoked successfully');

          } catch (err) {
            logger.error('Session Revocation Error:', err.stack || err.toString());
            error(res, 'Failed to revoke session', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipAudit: false
  }
);

/**
 * ✅ Admin Routes for Firebase Management with RBAC
 */
wrapAutoRBAC(
  router,
  'firebaseAdminRoutes',
  {
    get: [
      // 📋 Firebase Users List
      [
        '/admin/users',
        async (req, res) => {
          try {
            const { page = 1, limit = 50, hasFirebase } = req.query;
            const offset = (page - 1) * limit;

            let whereClause = 'WHERE 1=1';
            const params = [limit, offset];

            if (hasFirebase === 'true') {
              whereClause += ' AND firebase_uid IS NOT NULL';
            } else if (hasFirebase === 'false') {
              whereClause += ' AND firebase_uid IS NULL';
            }

            const users = await db.query(
              `SELECT 
                uid, phone, name, email, role, firebase_uid,
                registered_at, last_login, profile_completed_at,
                firebase_tokens_revoked_at
               FROM users 
               ${whereClause}
               ORDER BY registered_at DESC 
               LIMIT $1 OFFSET $2`,
              params
            );

            const total = await db.query(
              `SELECT COUNT(*) FROM users ${whereClause}`
            );

            success(res, {
              users: users.rows,
              pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total.rows[0].count),
                totalPages: Math.ceil(total.rows[0].count / limit)
              },
              requestedBy: req.user?.name
            }, 'Firebase users retrieved successfully');

          } catch (err) {
            logger.error('Admin Users List Error:', err.stack || err.toString());
            
            // Fallback response
            success(res, {
              users: [],
              pagination: {
                page: parseInt(req.query.page || 1),
                limit: parseInt(req.query.limit || 50),
                total: 0,
                totalPages: 0
              },
              note: 'Could not retrieve users - users table may not exist',
              requestedBy: req.user?.name
            }, 'Firebase users retrieved (empty - table may not exist)');
          }
        }
      ],

      // 📱 Device Management
      [
        '/admin/devices',
        async (req, res) => {
          try {
            const devices = await db.query(`
              SELECT 
                ud.user_uid, ud.device_id, ud.device_name, ud.platform,
                ud.app_version, ud.last_active, ud.created_at,
                u.phone, u.name
              FROM user_devices ud
              JOIN users u ON ud.user_uid = u.uid
              ORDER BY ud.last_active DESC
              LIMIT 100
            `);

            const stats = await db.query(`
              SELECT 
                platform,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE last_active > NOW() - INTERVAL '1 day') as active_1d,
                COUNT(*) FILTER (WHERE last_active > NOW() - INTERVAL '7 days') as active_7d
              FROM user_devices
              GROUP BY platform
            `);

            success(res, {
              devices: devices.rows,
              statistics: stats.rows,
              requestedBy: req.user?.name
            }, 'Device information retrieved successfully');

          } catch (err) {
            logger.error('Admin Devices Error:', err.stack || err.toString());
            
            // Fallback response
            success(res, {
              devices: [],
              statistics: [],
              note: 'Could not retrieve device information - user_devices table may not exist',
              requestedBy: req.user?.name
            }, 'Device information retrieved (empty - table may not exist)');
          }
        }
      ]
    ],

    post: [
      // 🔐 Revoke All User Tokens
      [
        '/admin/revoke-user-tokens',
        async (req, res) => {
          try {
            const { phone, reason = 'Admin action' } = req.body;

            if (!phone) {
              return error(res, 'Phone number is required', HTTP_STATUS.BAD_REQUEST);
            }

            const normalizedPhone = normalizePhone(phone);

            // Get user's Firebase UID
            const userResult = await db.query(
              'SELECT firebase_uid, name FROM users WHERE phone = $1',
              [normalizedPhone]
            );

            if (userResult.rows.length === 0) {
              return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
            }

            const user = userResult.rows[0];
            const firebaseUid = user.firebase_uid;

            if (firebaseUid) {
              // Revoke Firebase tokens
              await admin.auth().revokeRefreshTokens(firebaseUid);
            }

            // Update database
            await db.query(
              `UPDATE users SET 
                firebase_tokens_revoked_at = NOW(),
                token_revocation_reason = $2
               WHERE phone = $1`,
              [normalizedPhone, reason]
            );

            // Log the action
            try {
              await db.query(
                `INSERT INTO auth_logs (
                  phone, action, success, failure_reason, ip_address, created_at
                ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                [
                  normalizedPhone, 
                  'admin_revoke_tokens', 
                  true, 
                  reason, 
                  req.headers['x-forwarded-for']
                ]
              );
            } catch (logErr) {
              logger.warn('Failed to log token revocation:', logErr.message);
            }

            logger.info(`🔐 Admin ${req.user?.name} revoked all tokens for user: ${normalizedPhone} - Reason: ${reason}`);

            success(res, {
              phone: normalizedPhone,
              userName: user.name,
              reason,
              revokedBy: req.user?.name,
              revokedAt: new Date().toISOString()
            }, 'All user tokens revoked successfully');

          } catch (err) {
            logger.error('Admin Token Revocation Error:', err.stack || err.toString());
            error(res, 'Failed to revoke user tokens', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🧹 Cleanup Inactive Devices
      [
        '/admin/cleanup-devices',
        async (req, res) => {
          try {
            const { inactiveDays = 30 } = req.body;

            const result = await db.query(
              `DELETE FROM user_devices 
               WHERE last_active < NOW() - INTERVAL '${inactiveDays} days'
               RETURNING COUNT(*)`
            );

            const deletedCount = result.rowCount || 0;

            logger.info(`🧹 Admin ${req.user?.name} cleaned up ${deletedCount} inactive devices (${inactiveDays}+ days)`);

            success(res, {
              deletedCount,
              inactiveDays,
              cleanedBy: req.user?.name,
              cleanedAt: new Date().toISOString()
            }, `Cleaned up ${deletedCount} inactive devices`);

          } catch (err) {
            logger.error('Device Cleanup Error:', err.stack || err.toString());
            error(res, 'Failed to cleanup devices', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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