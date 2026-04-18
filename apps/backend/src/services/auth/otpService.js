// src/services/auth/otpService.js - OTP Service
// NOTE: This service is NOT for patient OTP (patients use Firebase)
// This is for: admin override, testing, special OTP needs
// OTPs are stored in database only, no SMS sending

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { OTP_CONFIG, OTP_ERRORS } from '../../config/otpConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

const OTP_HASH_ROUNDS = 6; // Lower than password hashing — OTPs are short-lived

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

  if (!OTP_CONFIG.devMode) {
    logger.info(`📱 OTP generated for ${normalizedPhone} (stored in DB, no SMS sent)`);
  }

  // Log successful request
  await logActivity(normalizedPhone, purpose, 'request', true, null, req);

  // Only log OTP in development mode — never log plaintext OTP in production
  if (OTP_CONFIG.devMode) {
    logger.info(`📱 OTP ${otp} generated for ${normalizedPhone} (${purpose}) - Session: ${sessionId}`);
  } else {
    logger.info(`📱 OTP generated for ${normalizedPhone} (${purpose}) - Session: ${sessionId}`);
  }

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
  const session = await prisma.otp_sessions.findFirst({
    where: {
      phone: normalizedPhone,
      purpose,
      verified: false,
    },
    orderBy: { created_at: 'desc' },
    select: { id: true, otp: true, expires_at: true, attempts: true, user_id: true },
  });

  if (!session) {
    await logActivity(normalizedPhone, purpose, 'verify', false, 'not_found', req);
    return { valid: false, reason: OTP_ERRORS.NOT_FOUND };
  }

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
  await prisma.otp_sessions.update({
    where: { id: session.id },
    data: { attempts: { increment: 1 } },
  });

  // Verify OTP — use bcrypt.compare for timing-safe comparison of hashed OTPs
  const isOtpValid = session.otp.startsWith('$2')
    ? await bcrypt.compare(inputOtp, session.otp)  // Hashed OTP (new format)
    : session.otp === inputOtp;                      // Legacy plaintext (migration-safe)

  if (!isOtpValid) {
    const attemptsLeft = OTP_CONFIG.maxAttempts - session.attempts - 1;
    await logActivity(normalizedPhone, purpose, 'verify', false, 'invalid_otp', req);
    return { valid: false, reason: OTP_ERRORS.INVALID, attemptsLeft };
  }

  // Mark as verified
  await prisma.otp_sessions.update({
    where: { id: session.id },
    data: { verified: true },
  });

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
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.otp_logs.count({
    where: {
      phone,
      action: 'request',
      created_at: { gt: oneDayAgo },
    },
  });
  return count < OTP_CONFIG.dailyLimit;
};

// Check resend cooldown
export const checkResendCooldown = async (phone, purpose) => {
  const cooldownThreshold = new Date(
    Date.now() - OTP_CONFIG.resendCooldownMinutes * 60 * 1000
  );
  const recentSession = await prisma.otp_sessions.findFirst({
    where: {
      phone,
      purpose,
      created_at: { gt: cooldownThreshold },
    },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  return !recentSession;
};

// Store OTP — hash before persisting to prevent plaintext exposure on DB compromise
export const storeOTP = async (phone, purpose, userId) => {
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));

  // Hash OTP before storage (bcrypt handles salt internally)
  const otpHash = await bcrypt.hash(otp, OTP_HASH_ROUNDS);

  const record = await prisma.otp_sessions.create({
    data: {
      phone,
      otp: otpHash,
      purpose,
      expires_at: expiresAt,
      attempts: 0,
      user_id: userId ?? null,
      verified: false,
    },
    select: { id: true },
  });

  return {
    otp,       // Return plaintext to caller (for SMS/dev display), NOT stored
    expiresAt,
    sessionId: record.id
  };
};

// Log OTP activity
export const logActivity = async (phone, purpose, action, success, failureReason = null, req) => {
  try {
    await prisma.otp_logs.create({
      data: {
        phone,
        purpose,
        action,
        success,
        failure_reason: failureReason,
        ip_address: req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress || null,
        user_agent: req?.headers?.['user-agent'] || null,
      },
    });
  } catch (dbError) {
    logger.warn('Failed to log OTP activity:', dbError.message);
  }
};

// Get health status
export const getHealthStatus = async () => {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [activeOtps, recentRequests, recentVerifications] = await Promise.all([
      prisma.otp_sessions.count({
        where: { verified: false, expires_at: { gt: new Date() } },
      }),
      prisma.otp_logs.count({
        where: { action: 'request', created_at: { gt: oneHourAgo } },
      }),
      prisma.otp_logs.count({
        where: { action: 'verify', success: true, created_at: { gt: oneHourAgo } },
      }),
    ]);

    return {
      status: 'healthy',
      activeOtps,
      recentRequests,
      recentVerifications,
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
