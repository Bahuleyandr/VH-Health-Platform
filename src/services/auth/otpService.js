// src/services/auth/otpService.js - OTP Service
// NOTE: This service is NOT for patient OTP (patients use Firebase)
// This is for: admin override, testing, special OTP needs
// OTPs are stored in database only, no SMS sending

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { OTP_CONFIG, OTP_ERRORS } from '../../config/otpConfig.js';
import crypto from 'crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';

// Generate secure OTP
export const generateOTP = () => {
  if (OTP_CONFIG.devMode) {
    return '123456';
  }
  return crypto.randomInt(100000, 999999).toString();
};

// Request OTP (stores in database only)
export const requestOtp = async (phone, purpose, userId, req) => {
  const normalizedPhone = normalizePhone(phone);
  
  // Check daily limit
  const dailyLimitOk = await checkDailyLimit(normalizedPhone);
  if (!dailyLimitOk) {
    await logActivity(normalizedPhone, purpose, 'request', false, 'daily_limit_exceeded', req);
    const error = new Error(OTP_ERRORS.DAILY_LIMIT);
    error.statusCode = HTTP_STATUS.TOO_MANY_REQUESTS;
    throw error;
  }
  
  // Check resend cooldown
  const cooldownOk = await checkResendCooldown(normalizedPhone, purpose);
  if (!cooldownOk) {
    await logActivity(normalizedPhone, purpose, 'request', false, 'resend_cooldown', req);
    const error = new Error(`${OTP_ERRORS.COOLDOWN} ${OTP_CONFIG.resendCooldownMinutes} minute(s)`);
    error.statusCode = HTTP_STATUS.TOO_MANY_REQUESTS;
    throw error;
  }
  
  // Generate and store OTP
  const { otp, expiresAt, sessionId } = await storeOTP(normalizedPhone, purpose, userId);
  
  // Note: We don't send SMS here. For patients, Firebase handles SMS.
  // This OTP is stored in database for admin/testing purposes only.
  if (!OTP_CONFIG.devMode) {
    logger.info(`📱 OTP generated for ${normalizedPhone} (stored in DB, no SMS sent)`);
  }
  
  // Log successful request
  await logActivity(normalizedPhone, purpose, 'request', true, null, req);
  
  logger.info(`📱 OTP ${otp} generated for ${normalizedPhone} (${purpose}) - Session: ${sessionId}`);
  
  return {
    phone: normalizedPhone,
    purpose,
    otpSent: true,
    sessionId,
    expiresInMinutes: OTP_CONFIG.expirationMinutes,
    attemptsAllowed: OTP_CONFIG.maxAttempts,
    ...(OTP_CONFIG.devMode && { devOtp: otp })
  };
};

// Verify OTP
export const verifyOtp = async (phone, inputOtp, purpose, req) => {
  const normalizedPhone = normalizePhone(phone);
  
  // Get active OTP session
  const result = await db.query(
    `SELECT id, otp, expires_at, attempts, user_id 
     FROM otp_sessions 
     WHERE phone = $1 AND purpose = $2 AND verified = false 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [normalizedPhone, purpose]
  );
  
  if (result.rows.length === 0) {
    await logActivity(normalizedPhone, purpose, 'verify', false, 'not_found', req);
    return { valid: false, reason: OTP_ERRORS.NOT_FOUND };
  }
  
  const session = result.rows[0];
  
  // Check expiration
  if (new Date() > new Date(session.expires_at)) {
    await logActivity(normalizedPhone, purpose, 'verify', false, 'expired', req);
    return { valid: false, reason: OTP_ERRORS.EXPIRED };
  }
  
  // Check attempts
  if (session.attempts >= OTP_CONFIG.maxAttempts) {
    await logActivity(normalizedPhone, purpose, 'verify', false, 'max_attempts', req);
    return { valid: false, reason: OTP_ERRORS.MAX_ATTEMPTS, attemptsLeft: 0 };
  }
  
  // Increment attempts
  await db.query(
    'UPDATE otp_sessions SET attempts = attempts + 1 WHERE id = $1',
    [session.id]
  );
  
  // Verify OTP
  if (session.otp !== inputOtp) {
    const attemptsLeft = OTP_CONFIG.maxAttempts - session.attempts - 1;
    await logActivity(normalizedPhone, purpose, 'verify', false, 'invalid_otp', req);
    return { valid: false, reason: OTP_ERRORS.INVALID, attemptsLeft };
  }
  
  // Mark as verified
  await db.query(
    'UPDATE otp_sessions SET verified = true, verified_at = NOW() WHERE id = $1',
    [session.id]
  );
  
  await logActivity(normalizedPhone, purpose, 'verify', true, null, req);
  
  return {
    valid: true,
    sessionId: session.id,
    userId: session.user_id,
    phone: normalizedPhone,
    purpose,
    verifiedAt: new Date().toISOString()
  };
};

// Check daily limit
export const checkDailyLimit = async (phone) => {
  const result = await db.query(
    `SELECT COUNT(*) FROM otp_logs 
     WHERE phone = $1 AND action = 'request' 
     AND created_at > NOW() - INTERVAL '24 hours'`,
    [phone]
  );
  
  return parseInt(result.rows[0].count) < OTP_CONFIG.dailyLimit;
};

// Check resend cooldown
export const checkResendCooldown = async (phone, purpose) => {
  const result = await db.query(
    `SELECT MAX(created_at) as last_request FROM otp_sessions 
     WHERE phone = $1 AND purpose = $2 
     AND created_at > NOW() - INTERVAL '${OTP_CONFIG.resendCooldownMinutes} minutes'`,
    [phone, purpose]
  );
  
  return !result.rows[0].last_request;
};

// Store OTP
export const storeOTP = async (phone, purpose, userId) => {
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));
  
  const result = await db.query(
    `INSERT INTO otp_sessions (
      phone, otp, purpose, expires_at, attempts, user_id, created_at, verified
    ) VALUES ($1, $2, $3, $4, 0, $5, NOW(), false) 
    RETURNING id`,
    [phone, otp, purpose, expiresAt, userId]
  );
  
  return {
    otp,
    expiresAt,
    sessionId: result.rows[0].id
  };
};

// Log OTP activity
export const logActivity = async (phone, purpose, action, success, failureReason = null, req) => {
  try {
    await db.query(
      `INSERT INTO otp_logs (
        phone, purpose, action, success, failure_reason, 
        ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        phone, purpose, action, success, failureReason,
        req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
        req.headers['user-agent']
      ]
    );
  } catch (dbError) {
    logger.warn('Failed to log OTP activity:', dbError.message);
  }
};

// Get health status
export const getHealthStatus = async () => {
  try {
    const [activeOtps, recentRequests, recentVerifications] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM otp_sessions 
         WHERE verified = false AND expires_at > NOW()`
      ),
      db.query(
        `SELECT COUNT(*) FROM otp_logs 
         WHERE action = 'request' AND created_at > NOW() - INTERVAL '1 hour'`
      ),
      db.query(
        `SELECT COUNT(*) FROM otp_logs 
         WHERE action = 'verify' AND success = true 
         AND created_at > NOW() - INTERVAL '1 hour'`
      )
    ]);
    
    return {
      status: 'healthy',
      activeOtps: parseInt(activeOtps.rows[0].count),
      recentRequests: parseInt(recentRequests.rows[0].count),
      recentVerifications: parseInt(recentVerifications.rows[0].count),
      config: {
        expirationMinutes: OTP_CONFIG.expirationMinutes,
        maxAttempts: OTP_CONFIG.maxAttempts,
        dailyLimit: OTP_CONFIG.dailyLimit
      },
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    logger.error('OTP Health Check Error:', err);
    return {
      status: 'degraded',
      message: 'OTP service temporarily unavailable',
      timestamp: new Date().toISOString()
    };
  }
};

// Send OTP via SMS (placeholder - implement with actual SMS provider)
const sendOTPViaSMS = async (phone, otp) => {
  // TODO: Implement actual SMS sending when SMS provider is configured
  logger.info(`[OTP] Generated for ${phone}: ${otp} (SMS not configured)`);
};