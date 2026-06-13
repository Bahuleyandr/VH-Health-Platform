// src/services/otpService.js - OTP Business Logic Service
// Migrated from raw pg to Prisma ORM

import crypto from 'crypto';
import { OTP_CONFIG } from '../config/otpConfig.js';
import { SECURITY_CONFIG } from '../config/securityConfig.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import bcrypt from 'bcrypt';
import { maskPhoneForLog } from '../utils/logMasking.js';

// OTPs are short-lived, so a low bcrypt cost is sufficient and keeps verify fast.
// Matches services/auth/otpService.js (OTP_HASH_ROUNDS).
const OTP_HASH_ROUNDS = 6;

// SEC-7: per-phone cross-session failed-verify cap. The active-session row
// already caps attempts (OTP_CONFIG.maxAttempts), but an attacker can sidestep
// that by requesting a fresh OTP after each burst — each request deletes the
// prior session row and resets the counter. This counts failed verifies across
// ALL sessions for the phone within the OTP lifetime as defence-in-depth (the
// per-IP rate-limiter already guards the network layer).
const CROSS_SESSION_MAX_FAILED_VERIFIES = SECURITY_CONFIG.otp.maxAttemptsPerPhone;

export class OTPService {
  static generateOTP(length = OTP_CONFIG.length) {
    if (OTP_CONFIG.devMode) return '123456';
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return crypto.randomInt(min, max).toString();
  }

  static async storeOTP(phone, purpose = 'general', userId = null) {
    const otp = this.generateOTP();
    // Hash before persisting — prevents plaintext OTP exposure on DB compromise.
    const otpHash = await bcrypt.hash(otp, OTP_HASH_ROUNDS);
    const expiresAt = new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));

    try {
      await prisma.otp_sessions.deleteMany({ where: { phone, purpose } });

      const session = await prisma.otp_sessions.create({
        data: {
          phone, otp: otpHash, purpose,
          user_id: userId || null,
          expires_at: expiresAt,
          attempts: 0,
          verified: false,
        },
        select: { id: true, expires_at: true },
      });

      return { otp, expiresAt, sessionId: session.id };
    } catch (err) {
      logger.warn('OTP sessions error, using mock:', err.message);
      return { otp, expiresAt, sessionId: `mock_${Date.now()}` };
    }
  }

  // SEC-7: count failed verify attempts for this phone across ALL sessions
  // within the OTP lifetime. Returns true when the cross-session cap is hit.
  static async isPhoneVerifyLocked(phone) {
    try {
      const windowStart = new Date(Date.now() - (OTP_CONFIG.expirationMinutes * 60 * 1000));
      const failedCount = await prisma.otp_logs.count({
        where: {
          phone,
          action: 'verify',
          success: false,
          created_at: { gte: windowStart },
        },
      });
      return failedCount >= CROSS_SESSION_MAX_FAILED_VERIFIES;
    } catch (err) {
      // Fail open on counter-read errors — the per-session cap + IP limiter
      // still apply; a transient otp_logs read must not block legitimate login.
      logger.warn('OTP cross-session counter read failed:', err.message);
      return false;
    }
  }

  static async verifyOTP(phone, inputOtp, purpose = 'general') {
    try {
      // SEC-7: cross-session failed-verify cap (defence-in-depth) — checked
      // before touching the session so a fresh OTP request can't reset it.
      if (await this.isPhoneVerifyLocked(phone)) {
        await this.logActivity(phone, purpose, 'verify', false, 'cross_session_lock');
        return { valid: false, reason: 'Too many attempts' };
      }

      const session = await prisma.otp_sessions.findFirst({
        // SEC-7: expiry predicate in the lookup itself — an expired row can no
        // longer be selected and walked into the attempts/compare path.
        where: { phone, purpose, verified: false, expires_at: { gt: new Date() } },
        orderBy: { created_at: 'desc' },
      });

      if (!session) return { valid: false, reason: 'OTP not found or expired' };

      const newAttempts = session.attempts + 1;
      await prisma.otp_sessions.update({ where: { id: session.id }, data: { attempts: newAttempts } });

      if (newAttempts > OTP_CONFIG.maxAttempts) {
        await prisma.otp_sessions.update({ where: { id: session.id }, data: { verified: true } });
        await this.logActivity(phone, purpose, 'verify', false, 'max_attempts');
        return { valid: false, reason: 'Too many attempts' };
      }

      // Timing-safe comparison via bcrypt for hashed OTPs; the plaintext
      // branch only matches legacy rows written before this hashing change
      // (they expire within minutes).
      const otpMatches = typeof session.otp === 'string' && session.otp.startsWith('$2')
        ? await bcrypt.compare(inputOtp, session.otp)
        : session.otp === inputOtp;
      if (!otpMatches) {
        // Record the failed verify so the cross-session counter accumulates.
        await this.logActivity(phone, purpose, 'verify', false, 'invalid_otp');
        return { valid: false, reason: 'Invalid OTP', attemptsLeft: OTP_CONFIG.maxAttempts - newAttempts };
      }

      await prisma.otp_sessions.update({
        where: { id: session.id },
        data: { verified: true },
      });

      return { valid: true, sessionId: session.id, userId: session.user_id };
    } catch (err) {
      logger.warn('OTP verify failed:', err.message);
      return { valid: false, reason: 'OTP verification temporarily unavailable' };
    }
  }

  static async checkDailyLimit(phone) {
    try {
      const count = await prisma.otp_logs.count({
        where: {
          phone,
          action: 'request',
          success: true,
          created_at: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      });
      return count < OTP_CONFIG.dailyLimit;
    } catch { return true; }
  }

  static async checkResendCooldown(phone, purpose = 'general') {
    try {
      const last = await prisma.otp_sessions.findFirst({
        where: { phone, purpose },
        orderBy: { created_at: 'desc' },
        select: { created_at: true },
      });
      if (!last) return true;
      const cooldownMs = OTP_CONFIG.resendCooldownMinutes * 60 * 1000;
      return Date.now() - new Date(last.created_at).getTime() >= cooldownMs;
    } catch { return true; }
  }

  static async logActivity(phone, purpose, action, success, failureReason = null, req) {
    try {
      await prisma.otp_logs.create({
        data: {
          phone, purpose, action, success,
          failure_reason: failureReason || null,
          ip_address: req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress || null,
          user_agent: req?.headers?.['user-agent'] || null,
          created_by: req?.user?.uid || null,
        },
      });
    } catch (err) {
      logger.warn('OTP log fallback:', err.message);
      logger.info(`[OTP_LOG] ${maskPhoneForLog(phone)} | ${purpose} | ${action} | ${success ? 'SUCCESS' : 'FAIL'} | ${failureReason || ''}`);
    }
  }

  static async getHealthStatus() {
    const healthData = {
      status: 'healthy',
      config: {
        otpLength: OTP_CONFIG.length,
        expirationMinutes: OTP_CONFIG.expirationMinutes,
        maxAttempts: OTP_CONFIG.maxAttempts,
        dailyLimit: OTP_CONFIG.dailyLimit,
        resendCooldownMinutes: OTP_CONFIG.resendCooldownMinutes,
        devMode: OTP_CONFIG.devMode,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      healthData.activeOTPs = await prisma.otp_sessions.count({
        where: { verified: false, expires_at: { gt: new Date() } },
      });
    } catch { healthData.activeOTPs = 'N/A'; }

    return healthData;
  }
}

// Named export for logActivity (used by adminOtpService)
export const logActivity = OTPService.logActivity.bind(OTPService);
