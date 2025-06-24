// src/routes/otpRoutes.js - Enhanced OTP Management System

import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator, otpValidator } from '../config/validationSchemas.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutesWithValidation, wrapRoutes } from '../config/routeWrapper.js';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import crypto from 'crypto';

const router = express.Router();

// ✅ OTP Configuration
const OTP_CONFIG = {
  length: 6,
  expirationMinutes: 5,
  maxAttempts: 3,
  resendCooldownMinutes: 1,
  dailyLimit: 10
};

// ✅ In-memory OTP store (In production, use Redis)
const otpStore = new Map();
const attemptStore = new Map();
const dailyLimitStore = new Map();

// ✅ Generate secure OTP
function generateOTP(length = OTP_CONFIG.length) {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return crypto.randomInt(min, max).toString();
}

// ✅ Store OTP with metadata
function storeOTP(phone, purpose = 'general') {
  const otp = generateOTP();
  const expiresAt = Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000);
  const key = `${phone}_${purpose}`;
  
  const otpData = {
    otp,
    phone,
    purpose,
    createdAt: Date.now(),
    expiresAt,
    attempts: 0,
    verified: false
  };
  
  otpStore.set(key, otpData);
  
  // Auto cleanup expired OTP
  setTimeout(() => {
    const stored = otpStore.get(key);
    if (stored && stored.expiresAt <= Date.now()) {
      otpStore.delete(key);
      attemptStore.delete(key);
    }
  }, OTP_CONFIG.expirationMinutes * 60 * 1000);
  
  return { otp, expiresAt };
}

// ✅ Verify OTP
function verifyOTP(phone, inputOtp, purpose = 'general') {
  const key = `${phone}_${purpose}`;
  const stored = otpStore.get(key);
  
  if (!stored) {
    return { valid: false, reason: 'OTP not found or expired' };
  }
  
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(key);
    attemptStore.delete(key);
    return { valid: false, reason: 'OTP expired' };
  }
  
  if (stored.verified) {
    return { valid: false, reason: 'OTP already used' };
  }
  
  // Check attempts
  stored.attempts += 1;
  
  if (stored.attempts > OTP_CONFIG.maxAttempts) {
    otpStore.delete(key);
    attemptStore.delete(key);
    return { valid: false, reason: 'Too many attempts' };
  }
  
  if (stored.otp !== inputOtp) {
    return { valid: false, reason: 'Invalid OTP', attemptsLeft: OTP_CONFIG.maxAttempts - stored.attempts };
  }
  
  // Mark as verified
  stored.verified = true;
  
  // Clean up after successful verification
  setTimeout(() => {
    otpStore.delete(key);
    attemptStore.delete(key);
  }, 60000); // Keep for 1 minute for potential duplicate requests
  
  return { valid: true, data: stored };
}

// ✅ Check daily limit
function checkDailyLimit(phone) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${phone}_${today}`;
  const count = dailyLimitStore.get(key) || 0;
  
  return count < OTP_CONFIG.dailyLimit;
}

// ✅ Increment daily count
function incrementDailyCount(phone) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${phone}_${today}`;
  const count = dailyLimitStore.get(key) || 0;
  
  dailyLimitStore.set(key, count + 1);
  
  // Clean up old entries (keep only today)
  for (const [k, v] of dailyLimitStore.entries()) {
    if (!k.includes(today)) {
      dailyLimitStore.delete(k);
    }
  }
}

// ✅ Check resend cooldown
function checkResendCooldown(phone, purpose = 'general') {
  const key = `${phone}_${purpose}`;
  const stored = otpStore.get(key);
  
  if (!stored) return true; // No previous OTP, can send
  
  const cooldownMs = OTP_CONFIG.resendCooldownMinutes * 60 * 1000;
  const timeSinceCreation = Date.now() - stored.createdAt;
  
  return timeSinceCreation >= cooldownMs;
}

// ✅ Public OTP Routes
wrapRoutesWithValidation(
  router,
  [], // No RBAC for public OTP routes
  {
    post: [
      // 📱 Request OTP
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
          const purpose = req.body.purpose || 'general'; // login, register, reset_password, etc.
          
          try {
            // Check daily limit
            if (!checkDailyLimit(phone)) {
              await pool.query(
                `INSERT INTO otp_logs (phone, purpose, action, success, failure_reason, ip_address, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [phone, purpose, 'request', false, 'daily_limit_exceeded', req.headers['x-forwarded-for']]
              );
              
              return error(res, 'Daily OTP limit exceeded. Try again tomorrow.', HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Check resend cooldown
            if (!checkResendCooldown(phone, purpose)) {
              return error(res, `Please wait ${OTP_CONFIG.resendCooldownMinutes} minute(s) before requesting another OTP`, HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Generate and store OTP
            const { otp, expiresAt } = storeOTP(phone, purpose);
            incrementDailyCount(phone);

            // Log OTP request
            await pool.query(
              `INSERT INTO otp_logs (phone, purpose, action, success, ip_address, user_agent, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [
                phone, purpose, 'request', true,
                req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
                req.headers['user-agent']
              ]
            );

            // In production, send OTP via SMS service here
            logger.info(`📱 OTP ${otp} generated for ${phone} (${purpose})`);

            success(res, {
              phone,
              purpose,
              otpSent: true,
              expiresInMinutes: OTP_CONFIG.expirationMinutes,
              attemptsAllowed: OTP_CONFIG.maxAttempts,
              // Remove in production
              devOtp: process.env.NODE_ENV === 'development' ? otp : undefined
            }, `OTP sent successfully for ${purpose}`);

          } catch (err) {
            logger.error('OTP Request Error:', err.stack || err.toString());
            error(res, 'Failed to send OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // ✅ Verify OTP
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
          const purpose = req.body.purpose || 'general';

          try {
            // Verify OTP
            const verification = verifyOTP(phone, inputOtp, purpose);
            
            // Log verification attempt
            await pool.query(
              `INSERT INTO otp_logs (
                phone, purpose, action, success, failure_reason, 
                ip_address, user_agent, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
              [
                phone, purpose, 'verify', verification.valid,
                verification.valid ? null : verification.reason,
                req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
                req.headers['user-agent']
              ]
            );

            if (!verification.valid) {
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                error: verification.reason,
                attemptsLeft: verification.attemptsLeft
              });
            }

            // OTP verified successfully
            logger.info(`✅ OTP verified for ${phone} (${purpose})`);

            success(res, {
              phone,
              purpose,
              verified: true,
              verifiedAt: new Date().toISOString()
            }, RESPONSE_MESSAGES.OTP_VERIFIED);

          } catch (err) {
            logger.error('OTP Verification Error:', err.stack || err.toString());
            error(res, 'OTP verification failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Resend OTP
      [
        '/resend-otp',
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
          const purpose = req.body.purpose || 'general';

          try {
            // Check if there's an existing OTP
            const key = `${phone}_${purpose}`;
            const existing = otpStore.get(key);
            
            if (!existing) {
              return error(res, 'No OTP found to resend. Please request a new OTP.', HTTP_STATUS.BAD_REQUEST);
            }

            // Check resend cooldown
            if (!checkResendCooldown(phone, purpose)) {
              return error(res, `Please wait ${OTP_CONFIG.resendCooldownMinutes} minute(s) before resending`, HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Check daily limit
            if (!checkDailyLimit(phone)) {
              return error(res, 'Daily OTP limit exceeded', HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Generate new OTP
            const { otp, expiresAt } = storeOTP(phone, purpose);
            incrementDailyCount(phone);

            // Log resend
            await pool.query(
              `INSERT INTO otp_logs (phone, purpose, action, success, ip_address, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW())`,
              [phone, purpose, 'resend', true, req.headers['x-forwarded-for']]
            );

            logger.info(`🔄 OTP resent for ${phone} (${purpose})`);

            success(res, {
              phone,
              purpose,
              otpResent: true,
              expiresInMinutes: OTP_CONFIG.expirationMinutes,
              // Remove in production
              devOtp: process.env.NODE_ENV === 'development' ? otp : undefined
            }, 'OTP resent successfully');

          } catch (err) {
            logger.error('OTP Resend Error:', err.stack || err.toString());
            error(res, 'Failed to resend OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    get: [
      // 📊 OTP Status Check
      [
        '/status',
        async (req, res) => {
          const { phone, purpose = 'general' } = req.query;
          
          if (!phone) {
            return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
          }

          const normalizedPhone = normalizePhone(phone);
          const key = `${normalizedPhone}_${purpose}`;
          const stored = otpStore.get(key);

          if (!stored) {
            return success(res, {
              phone: normalizedPhone,
              purpose,
              hasActiveOTP: false
            }, 'No active OTP found');
          }

          const isExpired = Date.now() > stored.expiresAt;
          const remainingTime = Math.max(0, stored.expiresAt - Date.now());

          success(res, {
            phone: normalizedPhone,
            purpose,
            hasActiveOTP: !isExpired,
            attemptsUsed: stored.attempts,
            attemptsRemaining: Math.max(0, OTP_CONFIG.maxAttempts - stored.attempts),
            expiresInSeconds: Math.floor(remainingTime / 1000),
            canResend: checkResendCooldown(normalizedPhone, purpose)
          }, 'OTP status retrieved');
        }
      ],

      // 🏥 OTP Service Health
      [
        '/health',
        async (req, res) => {
          try {
            const activeOTPs = otpStore.size;
            const dailyRequests = Array.from(dailyLimitStore.values()).reduce((sum, count) => sum + count, 0);

            // Get recent statistics
            const recentStats = await pool.query(`
              SELECT 
                purpose,
                action,
                COUNT(*) as count,
                COUNT(*) FILTER (WHERE success = true) as successful,
                COUNT(*) FILTER (WHERE success = false) as failed
              FROM otp_logs 
              WHERE created_at > NOW() - INTERVAL '1 hour'
              GROUP BY purpose, action
            `);

            success(res, {
              status: 'healthy',
              activeOTPs,
              dailyRequests,
              recentActivity: recentStats.rows,
              config: {
                otpLength: OTP_CONFIG.length,
                expirationMinutes: OTP_CONFIG.expirationMinutes,
                maxAttempts: OTP_CONFIG.maxAttempts,
                dailyLimit: OTP_CONFIG.dailyLimit
              },
              timestamp: new Date().toISOString()
            }, 'OTP service is healthy');

          } catch (err) {
            logger.error('OTP Health Check Error:', err);
            error(res, 'OTP service unhealthy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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

// ✅ Admin Routes for OTP Management
wrapRoutes(
  router,
  ['ADMIN'], // Admin only
  {
    get: [
      // 📋 OTP Usage Analytics
      [
        '/admin/analytics',
        async (req, res) => {
          try {
            const { startDate, endDate, purpose } = req.query;
            
            let whereClause = 'WHERE 1=1';
            const params = [];
            let paramIndex = 1;

            if (startDate) {
              whereClause += ` AND created_at >= ${paramIndex}`;
              params.push(startDate);
              paramIndex++;
            }

            if (endDate) {
              whereClause += ` AND created_at <= ${paramIndex}`;
              params.push(endDate);
              paramIndex++;
            }

            if (purpose) {
              whereClause += ` AND purpose = ${paramIndex}`;
              params.push(purpose);
              paramIndex++;
            }

            // OTP usage statistics
            const usageStats = await pool.query(`
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
            `, params);

            // Failure analysis
            const failureStats = await pool.query(`
              SELECT 
                failure_reason,
                COUNT(*) as count,
                COUNT(DISTINCT phone) as unique_users
              FROM otp_logs 
              ${whereClause} AND success = false
              GROUP BY failure_reason
              ORDER BY count DESC
            `, params);

            // Top users by OTP requests
            const topUsers = await pool.query(`
              SELECT 
                phone,
                COUNT(*) as otp_requests,
                COUNT(DISTINCT purpose) as purposes_used,
                COUNT(*) FILTER (WHERE success = true) as successful_verifications
              FROM otp_logs 
              ${whereClause}
              GROUP BY phone
              ORDER BY otp_requests DESC
              LIMIT 20
            `, params);

            success(res, {
              usageStatistics: usageStats.rows,
              failureAnalysis: failureStats.rows,
              topUsers: topUsers.rows,
              currentActiveOTPs: otpStore.size,
              queryPeriod: { startDate, endDate, purpose }
            }, 'OTP analytics retrieved');

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
            // Unusual OTP activity patterns
            const suspiciousActivity = await pool.query(`
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
            `);

            // Failed verification patterns
            const failurePatterns = await pool.query(`
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
              HAVING COUNT(*) >= ${OTP_CONFIG.maxAttempts * 2}
              ORDER BY failed_attempts DESC
            `);

            // Geographic anomalies (if IP geolocation available)
            const ipAnalysis = await pool.query(`
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
            `);

            success(res, {
              suspiciousActivity: suspiciousActivity.rows,
              failurePatterns: failurePatterns.rows,
              ipAnalysis: ipAnalysis.rows,
              alertsGenerated: new Date().toISOString(),
              recommendations: {
                suspiciousUsers: suspiciousActivity.rows.length,
                shouldInvestigate: failurePatterns.rows.length > 0,
                suspiciousIPs: ipAnalysis.rows.length
              }
            }, 'OTP security alerts generated');

          } catch (err) {
            logger.error('OTP Security Alerts Error:', err);
            error(res, 'Failed to generate security alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📱 Active OTP Sessions
      [
        '/admin/active-sessions',
        async (req, res) => {
          try {
            const activeSessions = [];
            
            for (const [key, data] of otpStore.entries()) {
              const isExpired = Date.now() > data.expiresAt;
              if (!isExpired) {
                activeSessions.push({
                  phone: data.phone,
                  purpose: data.purpose,
                  createdAt: new Date(data.createdAt).toISOString(),
                  expiresAt: new Date(data.expiresAt).toISOString(),
                  attempts: data.attempts,
                  verified: data.verified,
                  remainingSeconds: Math.floor((data.expiresAt - Date.now()) / 1000)
                });
              }
            }

            // Sort by creation time
            activeSessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            success(res, {
              activeSessions,
              totalActive: activeSessions.length,
              byPurpose: activeSessions.reduce((acc, session) => {
                acc[session.purpose] = (acc[session.purpose] || 0) + 1;
                return acc;
              }, {}),
              timestamp: new Date().toISOString()
            }, 'Active OTP sessions retrieved');

          } catch (err) {
            logger.error('Active Sessions Error:', err);
            error(res, 'Failed to fetch active sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 OTP Logs with Advanced Filtering
      [
        '/admin/logs',
        async (req, res) => {
          try {
            const { 
              page = 1, limit = 100, phone, purpose, action, 
              success, startDate, endDate, ipAddress 
            } = req.query;
            
            const offset = (page - 1) * limit;
            let whereClause = 'WHERE 1=1';
            const params = [limit, offset];
            let paramIndex = 3;

            if (phone) {
              const normalizedPhone = normalizePhone(phone);
              whereClause += ` AND phone = ${paramIndex}`;
              params.push(normalizedPhone);
              paramIndex++;
            }

            if (purpose) {
              whereClause += ` AND purpose = ${paramIndex}`;
              params.push(purpose);
              paramIndex++;
            }

            if (action) {
              whereClause += ` AND action = ${paramIndex}`;
              params.push(action);
              paramIndex++;
            }

            if (success !== undefined) {
              whereClause += ` AND success = ${paramIndex}`;
              params.push(success === 'true');
              paramIndex++;
            }

            if (startDate) {
              whereClause += ` AND created_at >= ${paramIndex}`;
              params.push(startDate);
              paramIndex++;
            }

            if (endDate) {
              whereClause += ` AND created_at <= ${paramIndex}`;
              params.push(endDate);
              paramIndex++;
            }

            if (ipAddress) {
              whereClause += ` AND ip_address = ${paramIndex}`;
              params.push(ipAddress);
              paramIndex++;
            }

            const logs = await pool.query(`
              SELECT 
                id, phone, purpose, action, success, failure_reason,
                ip_address, user_agent, created_at
              FROM otp_logs 
              ${whereClause}
              ORDER BY created_at DESC
              LIMIT $1 OFFSET $2
            `, params);

            const total = await pool.query(
              `SELECT COUNT(*) FROM otp_logs ${whereClause}`,
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
              filters: { phone, purpose, action, success, startDate, endDate, ipAddress }
            }, 'OTP logs retrieved');

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
        async (req, res) => {
          try {
            const { phone, purpose, reason = 'Admin action' } = req.body;
            const adminUid = req.user?.uid;

            if (!phone) {
              return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
            }

            const normalizedPhone = normalizePhone(phone);
            const keysToRevoke = [];

            if (purpose) {
              keysToRevoke.push(`${normalizedPhone}_${purpose}`);
            } else {
              // Revoke all OTPs for this phone
              for (const key of otpStore.keys()) {
                if (key.startsWith(normalizedPhone + '_')) {
                  keysToRevoke.push(key);
                }
              }
            }

            let revokedCount = 0;
            for (const key of keysToRevoke) {
              if (otpStore.has(key)) {
                otpStore.delete(key);
                attemptStore.delete(key);
                revokedCount++;
              }
            }

            // Log the revocation
            await pool.query(
              `INSERT INTO otp_logs (
                phone, purpose, action, success, failure_reason, 
                ip_address, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [
                normalizedPhone, 
                purpose || 'all', 
                'admin_revoke', 
                true, 
                reason, 
                req.headers['x-forwarded-for']
              ]
            );

            logger.info(`🔐 Admin revoked ${revokedCount} OTP(s) for ${normalizedPhone} - Reason: ${reason}`);

            success(res, {
              phone: normalizedPhone,
              purpose: purpose || 'all',
              revokedCount,
              reason,
              revokedBy: adminUid
            }, `${revokedCount} OTP(s) revoked successfully`);

          } catch (err) {
            logger.error('Revoke OTP Error:', err);
            error(res, 'Failed to revoke OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🧹 Cleanup OTP Logs
      [
        '/admin/cleanup-logs',
        async (req, res) => {
          try {
            const { olderThanDays = 30 } = req.body;
            const adminUid = req.user?.uid;

            const result = await pool.query(
              `DELETE FROM otp_logs 
               WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'
               RETURNING COUNT(*)`
            );

            const deletedCount = result.rowCount;

            logger.info(`🧹 Admin cleaned up ${deletedCount} OTP logs older than ${olderThanDays} days`);

            success(res, {
              deletedCount,
              olderThanDays,
              cleanedBy: adminUid,
              timestamp: new Date().toISOString()
            }, `Cleaned up ${deletedCount} old OTP logs`);

          } catch (err) {
            logger.error('OTP Logs Cleanup Error:', err);
            error(res, 'Failed to cleanup logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // ⚙️ Update OTP Configuration
      [
        '/admin/update-config',
        async (req, res) => {
          try {
            const { 
              expirationMinutes, 
              maxAttempts, 
              dailyLimit, 
              resendCooldownMinutes 
            } = req.body;
            
            const adminUid = req.user?.uid;
            const updates = {};

            if (expirationMinutes && expirationMinutes > 0 && expirationMinutes <= 60) {
              OTP_CONFIG.expirationMinutes = expirationMinutes;
              updates.expirationMinutes = expirationMinutes;
            }

            if (maxAttempts && maxAttempts > 0 && maxAttempts <= 10) {
              OTP_CONFIG.maxAttempts = maxAttempts;
              updates.maxAttempts = maxAttempts;
            }

            if (dailyLimit && dailyLimit > 0 && dailyLimit <= 100) {
              OTP_CONFIG.dailyLimit = dailyLimit;
              updates.dailyLimit = dailyLimit;
            }

            if (resendCooldownMinutes && resendCooldownMinutes >= 0 && resendCooldownMinutes <= 10) {
              OTP_CONFIG.resendCooldownMinutes = resendCooldownMinutes;
              updates.resendCooldownMinutes = resendCooldownMinutes;
            }

            if (Object.keys(updates).length === 0) {
              return error(res, 'No valid configuration updates provided', HTTP_STATUS.BAD_REQUEST);
            }

            logger.info(`⚙️ OTP configuration updated by admin ${adminUid}:`, updates);

            success(res, {
              previousConfig: { ...OTP_CONFIG },
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
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// ✅ Utility Routes for Integration Testing
if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
  wrapRoutes(
    router,
    [], // Public in dev/test
    {
      post: [
        // 🧪 Test OTP Generation (Dev/Test Only)
        [
          '/dev/generate-test-otp',
          async (req, res) => {
            const { phone, purpose = 'test' } = req.body;
            
            if (!phone) {
              return error(res, 'Phone required', HTTP_STATUS.BAD_REQUEST);
            }

            const normalizedPhone = normalizePhone(phone);
            const { otp, expiresAt } = storeOTP(normalizedPhone, purpose);

            success(res, {
              phone: normalizedPhone,
              purpose,
              otp, // Only in dev/test
              expiresAt: new Date(expiresAt).toISOString(),
              warning: 'This endpoint is only available in development/test environments'
            }, 'Test OTP generated');
          }
        ]
      ],

      delete: [
        // 🧪 Clear All OTPs (Dev/Test Only)
        [
          '/dev/clear-all',
          async (req, res) => {
            const clearedCount = otpStore.size;
            otpStore.clear();
            attemptStore.clear();
            dailyLimitStore.clear();

            success(res, {
              clearedCount,
              warning: 'This endpoint is only available in development/test environments'
            }, 'All OTPs cleared');
          }
        ]
      ]
    },
    {
      requireUID: false,
      requirePhone: false
    }
  );
}

export default router;