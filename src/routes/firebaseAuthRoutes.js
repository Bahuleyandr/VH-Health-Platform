// src/routes/firebaseAuthRoutes.js - Enhanced Firebase Authentication

import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator, userProfileValidator } from '../config/validationSchemas.js';
import * as firebaseAuthController from '../controllers/firebaseAuthController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../config/routeWrapper.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import admin from '../utils/firebaseAdmin.js';
import { generateToken } from '../utils/jwtUtils.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

/**
 * ✅ Enhanced Firebase Authentication Routes
 * Handles Firebase ID token verification, user registration, and profile management
 */
wrapRoutesWithValidation(
  router,
  [], // Public routes
  {
    post: [
      // 🔥 Firebase ID Token Authentication
      [
        '/firebase-login',
        async (req, res) => {
          const { idToken, deviceInfo } = req.body;

          if (!idToken) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              message: 'Firebase ID token is required'
            });
          }

          try {
            // Verify Firebase ID token
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            
            const firebasePhone = decodedToken.phone_number;
            if (!firebasePhone) {
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                message: 'Phone number not found in Firebase token'
              });
            }

            const phone = normalizePhone(firebasePhone);
            const firebaseUid = decodedToken.uid;

            // Check if user exists in our database
            let userResult = await pool.query(
              'SELECT * FROM users WHERE phone = $1 OR firebase_uid = $2',
              [phone, firebaseUid]
            );

            let user;
            let isNewUser = false;

            if (userResult.rows.length === 0) {
              // Create new user
              const insertResult = await pool.query(
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
                await pool.query(
                  'UPDATE users SET firebase_uid = $1, last_login = NOW() WHERE uid = $2',
                  [firebaseUid, user.uid]
                );
              } else {
                await pool.query(
                  'UPDATE users SET last_login = NOW() WHERE uid = $1',
                  [user.uid]
                );
              }
              
              logger.info(`🔥 Existing Firebase user logged in: ${phone}`);
            }

            // Generate our JWT token
            const accessToken = generateToken({
              uid: user.uid,
              phone: user.phone,
              role: user.role,
              firebaseUid: firebaseUid
            });

            // Store device info if provided
            if (deviceInfo) {
              try {
                await pool.query(
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
            await pool.query(
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

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              message: isNewUser ? 'User registered successfully' : 'Login successful',
              accessToken,
              user: {
                uid: user.uid,
                phone: user.phone,
                name: user.name,
                email: user.email,
                role: user.role,
                profileComplete: !!(user.name && user.gender),
                emailVerified: user.email_verified,
                isNewUser
              }
            });

          } catch (error) {
            logger.error('Firebase Login Error:', error.stack || error.toString());
            
            if (error.code === 'auth/id-token-expired') {
              return res.status(HTTP_STATUS.UNAUTHORIZED).json({
                success: false,
                message: 'Firebase token has expired'
              });
            }
            
            if (error.code === 'auth/id-token-revoked') {
              return res.status(HTTP_STATUS.UNAUTHORIZED).json({
                success: false,
                message: 'Firebase token has been revoked'
              });
            }

            return res.status(HTTP_STATUS.UNAUTHORIZED).json({
              success: false,
              message: 'Invalid Firebase ID token'
            });
          }
        }
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
            anniversary, address, emergencyContact 
          } = req.body;

          try {
            const normalizedPhone = normalizePhone(phone);

            // Update user profile
            const result = await pool.query(
              `UPDATE users SET 
                name = $1, gender = $2, email = $3, birthday = $4,
                anniversary = $5, address = $6, emergency_contact = $7,
                profile_completed_at = NOW()
              WHERE phone = $8 
              RETURNING *`,
              [
                name, gender, email, birthday,
                anniversary, address, emergencyContact,
                normalizedPhone
              ]
            );

            if (result.rows.length === 0) {
              return res.status(HTTP_STATUS.NOT_FOUND).json({
                success: false,
                message: 'User not found'
              });
            }

            const user = result.rows[0];

            logger.info(`👤 Profile completed for user: ${normalizedPhone}`);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              message: 'Profile completed successfully',
              user: {
                uid: user.uid,
                phone: user.phone,
                name: user.name,
                gender: user.gender,
                email: user.email,
                role: user.role,
                profileComplete: true
              }
            });

          } catch (error) {
            logger.error('Profile Completion Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to complete profile'
            });
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
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              message: 'Firebase ID token and OTP are required'
            });
          }

          try {
            // Verify Firebase ID token
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            const firebaseUid = decodedToken.uid;
            const normalizedPhone = normalizePhone(phone);

            // Verify OTP (you would implement OTP verification here)
            // For demo purposes, accepting "123456" as valid OTP
            if (otp !== '123456') {
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                message: 'Invalid OTP'
              });
            }

            // Check if user exists
            const userResult = await pool.query(
              'SELECT * FROM users WHERE phone = $1',
              [normalizedPhone]
            );

            if (userResult.rows.length === 0) {
              return res.status(HTTP_STATUS.NOT_FOUND).json({
                success: false,
                message: 'User not found'
              });
            }

            const user = userResult.rows[0];

            // Link Firebase UID to existing user
            await pool.query(
              'UPDATE users SET firebase_uid = $1 WHERE uid = $2',
              [firebaseUid, user.uid]
            );

            // Generate new token with Firebase UID
            const accessToken = generateToken({
              uid: user.uid,
              phone: user.phone,
              role: user.role,
              firebaseUid: firebaseUid
            });

            logger.info(`🔗 Firebase account linked to existing user: ${normalizedPhone}`);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              message: 'Account linked successfully',
              accessToken,
              user: {
                uid: user.uid,
                phone: user.phone,
                name: user.name,
                role: user.role,
                linkedToFirebase: true
              }
            });

          } catch (error) {
            logger.error('Account Linking Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to link account'
            });
          }
        }
      ],

      // 📱 Update FCM Token for Push Notifications
      [
        '/update-fcm-token',
        async (req, res) => {
          const { phone, fcmToken, deviceId } = req.body;

          if (!phone || !fcmToken) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              message: 'Phone and FCM token are required'
            });
          }

          try {
            const normalizedPhone = normalizePhone(phone);

            // Update or insert FCM token
            await pool.query(
              `INSERT INTO user_devices (user_uid, device_id, fcm_token, last_active, created_at)
               SELECT uid, $2, $3, NOW(), NOW() FROM users WHERE phone = $1
               ON CONFLICT (user_uid, device_id)
               DO UPDATE SET fcm_token = EXCLUDED.fcm_token, last_active = NOW()`,
              [normalizedPhone, deviceId || 'default', fcmToken]
            );

            logger.info(`📱 FCM token updated for user: ${normalizedPhone}`);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              message: 'FCM token updated successfully'
            });

          } catch (error) {
            logger.error('FCM Token Update Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to update FCM token'
            });
          }
        }
      ],

      // 🔐 Revoke Firebase Session
      [
        '/revoke-session',
        async (req, res) => {
          const { firebaseUid } = req.body;

          if (!firebaseUid) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              message: 'Firebase UID is required'
            });
          }

          try {
            // Revoke Firebase tokens
            await admin.auth().revokeRefreshTokens(firebaseUid);

            // Log the revocation
            await pool.query(
              `UPDATE users SET firebase_tokens_revoked_at = NOW() 
               WHERE firebase_uid = $1`,
              [firebaseUid]
            );

            logger.info(`🔐 Firebase session revoked for UID: ${firebaseUid}`);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              message: 'Firebase session revoked successfully'
            });

          } catch (error) {
            logger.error('Session Revocation Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to revoke session'
            });
          }
        }
      ]
    ],

    get: [
      // 🔍 Verify Token Status
      [
        '/verify-token',
        async (req, res) => {
          const { idToken } = req.query;

          if (!idToken) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              message: 'Firebase ID token is required'
            });
          }

          try {
            const decodedToken = await admin.auth().verifyIdToken(idToken, true);
            
            // Check if user exists in our system
            const userResult = await pool.query(
              'SELECT uid, phone, name, role FROM users WHERE firebase_uid = $1',
              [decodedToken.uid]
            );

            const userExists = userResult.rows.length > 0;

            return res.status(HTTP_STATUS.OK).json({
              success: true,
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
            });

          } catch (error) {
            logger.error('Token Verification Error:', error.stack || error.toString());
            
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
            const stats = await pool.query(`
              SELECT 
                COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL) as firebase_users,
                COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND last_login > NOW() - INTERVAL '24 hours') as active_firebase_users_24h,
                COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND profile_completed_at IS NOT NULL) as completed_profiles,
                COUNT(*) as total_users
              FROM users
            `);

            const deviceStats = await pool.query(`
              SELECT 
                platform,
                COUNT(*) as device_count,
                COUNT(*) FILTER (WHERE last_active > NOW() - INTERVAL '24 hours') as active_24h
              FROM user_devices
              GROUP BY platform
            `);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              status: 'healthy',
              firebaseConnection: 'connected',
              statistics: stats.rows[0],
              deviceStatistics: deviceStats.rows,
              timestamp: new Date().toISOString()
            });

          } catch (error) {
            logger.error('Firebase Health Check Error:', error.stack || error.toString());
            
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              status: 'unhealthy',
              error: 'Firebase connection failed'
            });
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

// ✅ Admin Routes for Firebase Management
wrapRoutesWithValidation(
  router,
  ['ADMIN'], // Admin only
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

            const users = await pool.query(
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

            const total = await pool.query(
              `SELECT COUNT(*) FROM users ${whereClause}`
            );

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              users: users.rows,
              pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total.rows[0].count),
                totalPages: Math.ceil(total.rows[0].count / limit)
              }
            });

          } catch (error) {
            logger.error('Admin Users List Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to fetch users'
            });
          }
        }
      ],

      // 📱 Device Management
      [
        '/admin/devices',
        async (req, res) => {
          try {
            const devices = await pool.query(`
              SELECT 
                ud.user_uid, ud.device_id, ud.device_name, ud.platform,
                ud.app_version, ud.last_active, ud.created_at,
                u.phone, u.name
              FROM user_devices ud
              JOIN users u ON ud.user_uid = u.uid
              ORDER BY ud.last_active DESC
              LIMIT 100
            `);

            const stats = await pool.query(`
              SELECT 
                platform,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE last_active > NOW() - INTERVAL '1 day') as active_1d,
                COUNT(*) FILTER (WHERE last_active > NOW() - INTERVAL '7 days') as active_7d
              FROM user_devices
              GROUP BY platform
            `);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              devices: devices.rows,
              statistics: stats.rows
            });

          } catch (error) {
            logger.error('Admin Devices Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to fetch device information'
            });
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
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                message: 'Phone number is required'
              });
            }

            const normalizedPhone = normalizePhone(phone);

            // Get user's Firebase UID
            const userResult = await pool.query(
              'SELECT firebase_uid FROM users WHERE phone = $1',
              [normalizedPhone]
            );

            if (userResult.rows.length === 0) {
              return res.status(HTTP_STATUS.NOT_FOUND).json({
                success: false,
                message: 'User not found'
              });
            }

            const firebaseUid = userResult.rows[0].firebase_uid;

            if (firebaseUid) {
              // Revoke Firebase tokens
              await admin.auth().revokeRefreshTokens(firebaseUid);
            }

            // Update database
            await pool.query(
              `UPDATE users SET 
                firebase_tokens_revoked_at = NOW(),
                token_revocation_reason = $2
               WHERE phone = $1`,
              [normalizedPhone, reason]
            );

            // Log the action
            await pool.query(
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

            logger.info(`🔐 Admin revoked all tokens for user: ${normalizedPhone} - Reason: ${reason}`);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              message: 'All user tokens revoked successfully',
              phone: normalizedPhone,
              reason
            });

          } catch (error) {
            logger.error('Admin Token Revocation Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to revoke user tokens'
            });
          }
        }
      ],

      // 🧹 Cleanup Inactive Devices
      [
        '/admin/cleanup-devices',
        async (req, res) => {
          try {
            const { inactiveDays = 30 } = req.body;

            const result = await pool.query(
              `DELETE FROM user_devices 
               WHERE last_active < NOW() - INTERVAL '${inactiveDays} days'
               RETURNING COUNT(*)`
            );

            const deletedCount = result.rowCount;

            logger.info(`🧹 Cleaned up ${deletedCount} inactive devices (${inactiveDays}+ days)`);

            return res.status(HTTP_STATUS.OK).json({
              success: true,
              message: `Cleaned up ${deletedCount} inactive devices`,
              deletedCount,
              inactiveDays
            });

          } catch (error) {
            logger.error('Device Cleanup Error:', error.stack || error.toString());
            return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
              success: false,
              message: 'Failed to cleanup devices'
            });
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