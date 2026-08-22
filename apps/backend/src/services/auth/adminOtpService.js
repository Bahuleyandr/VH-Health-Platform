// src/services/auth/adminOtpService.js - Admin OTP Service

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { OTP_CONFIG } from '../../config/otpConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { buildPagination } from '../../utils/listQuery.js';
import * as otpService from './otpService.js';


const query = async (sql, params = []) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    const rows = await prisma.$queryRawUnsafe(normalizedSql, ...params);
    return { rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
  }

  const rowCount = await prisma.$executeRawUnsafe(normalizedSql, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
};


// Get OTP analytics
export const getOtpAnalytics = async ({ startDate, endDate, purpose, requestedBy }) => {
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
  
  const [usageStatsResult, failureStatsResult, topUsersResult] = await Promise.all([
    query(`
      SELECT
        DATE(created_at) AS date, purpose, action,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE success = true)::int AS successful_count,
        COUNT(*) FILTER (WHERE success = false)::int AS failed_count,
        COUNT(DISTINCT phone)::int AS unique_users
      FROM otp_logs
      ${whereClause}
      GROUP BY DATE(created_at), purpose, action
      ORDER BY date DESC, purpose, action
    `, params),
    query(`
      SELECT failure_reason, COUNT(*)::int AS count, COUNT(DISTINCT phone)::int AS unique_users
      FROM otp_logs ${whereClause} AND success = false AND failure_reason IS NOT NULL
      GROUP BY failure_reason ORDER BY count DESC
    `, params),
    query(`
      SELECT phone, COUNT(*)::int AS otp_requests, COUNT(DISTINCT purpose)::int AS purposes_used,
             COUNT(*) FILTER (WHERE success = true AND action = 'verify')::int AS successful_verifications
      FROM otp_logs ${whereClause} GROUP BY phone ORDER BY otp_requests DESC LIMIT 20
    `, params),
  ]);
  return {
    usageStatistics: usageStatsResult.rows,
    failureAnalysis: failureStatsResult.rows,
    topUsers: topUsersResult.rows,
    queryPeriod: { startDate, endDate, purpose },
    generatedBy: requestedBy,
    timestamp: new Date().toISOString()
  };
};

// Get OTP logs with filtering
export const getOtpLogs = async (filters, requestedBy) => {
  const { page, limit, phone, purpose, action, success, startDate, endDate, ipAddress } = filters;

  const offset = (page - 1) * limit;
  const where = {};

  if (phone) {
    where.phone = normalizePhone(phone);
  }

  if (purpose) {
    where.purpose = purpose;
  }

  if (action) {
    where.action = action;
  }

  if (success !== undefined) {
    where.success = success === true || success === 'true';
  }

  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at.gte = new Date(startDate);
    if (endDate) where.created_at.lte = new Date(endDate);
  }

  if (ipAddress) {
    where.ip_address = ipAddress;
  }

  const [logs, totalCount] = await Promise.all([
    prisma.otp_logs.findMany({
      where,
      select: { id: true, phone: true, purpose: true, action: true, success: true, failure_reason: true, ip_address: true, user_agent: true, created_at: true, created_by: true },
      orderBy: { created_at: 'desc' },
      skip: offset,
      take: parseInt(limit),
    }),
    prisma.otp_logs.count({ where }),
  ]);
  return {
    logs,
    pagination: buildPagination(totalCount, page, limit),
    filters: { phone, purpose, action, success, startDate, endDate, ipAddress },
    generatedBy: requestedBy
  };
};

// Cleanup OTP logs
export const cleanupOtpLogs = async (olderThanDays, adminUid) => {
  const result = await query(
    `DELETE FROM otp_logs
     WHERE created_at < NOW() - make_interval(days => $1)`,
    [olderThanDays]
  );
  
  const deletedCount = result.rowCount || 0;
  
  logger.info(`🧹 Admin cleaned up ${deletedCount} OTP logs older than ${olderThanDays} days`);
  
  return {
    deletedCount,
    olderThanDays,
    cleanedBy: adminUid,
    timestamp: new Date().toISOString()
  };
};

// Update OTP configuration
export const updateOtpConfiguration = async (updates, adminUid) => {
  const previousConfig = { ...OTP_CONFIG };
  const validUpdates = {};
  
  if (updates.expirationMinutes !== undefined) {
    OTP_CONFIG.expirationMinutes = updates.expirationMinutes;
    validUpdates.expirationMinutes = updates.expirationMinutes;
  }
  
  if (updates.maxAttempts !== undefined) {
    OTP_CONFIG.maxAttempts = updates.maxAttempts;
    validUpdates.maxAttempts = updates.maxAttempts;
  }
  
  if (updates.dailyLimit !== undefined) {
    OTP_CONFIG.dailyLimit = updates.dailyLimit;
    validUpdates.dailyLimit = updates.dailyLimit;
  }
  
  if (updates.resendCooldownMinutes !== undefined) {
    OTP_CONFIG.resendCooldownMinutes = updates.resendCooldownMinutes;
    validUpdates.resendCooldownMinutes = updates.resendCooldownMinutes;
  }
  
  if (Object.keys(validUpdates).length === 0) {
    const error = new Error('No valid configuration updates provided');
    error.statusCode = 400;
    throw error;
  }
  
  logger.info(`⚙️ OTP configuration updated by admin ${adminUid}:`, validUpdates);
  
  return {
    previousConfig,
    updates: validUpdates,
    newConfig: OTP_CONFIG,
    updatedBy: adminUid,
    timestamp: new Date().toISOString()
  };
};

// Force send OTP
export const forceSendOtp = async (phone, purpose, reason, bypassLimits, adminUid, req) => {
  const normalizedPhone = normalizePhone(phone);
  
  // Generate OTP directly
  const otp = OTP_CONFIG.devMode ? '123456' : crypto.randomInt(100000, 999999).toString();
  // Hash before storage — never persist the plaintext OTP (DB-compromise exposure).
  // Verifiers use bcrypt.compare for $2-prefixed values (see otpService.verifyOTP).
  const otpHash = await bcrypt.hash(otp, 6);
  const expiresAt = new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));

  // Store OTP (hashed)
  const result = await query(`
    INSERT INTO otp_sessions (
      phone, otp, purpose, expires_at,
      attempts, created_at, verified
    ) VALUES ($1, $2, $3, $4, 0, NOW(), false)
    RETURNING id
  `, [normalizedPhone, otpHash, purpose, expiresAt]);
  
  if (!result.rows || result.rows.length === 0) {
    throw new Error('Failed to create OTP session: INSERT ... RETURNING produced no row');
  }
  const sessionId = result.rows[0].id;
  
  // Log the admin action
  await otpService.logActivity(normalizedPhone, purpose, 'admin_force_send', true, reason, req);
  
  logger.info(`📨 Admin force-sent OTP for ${maskPhoneForLog(normalizedPhone)} - Reason: ${reason}`);
  
  return {
    phone: normalizedPhone,
    purpose,
    otpSent: true,
    sessionId,
    reason,
    bypassLimits,
    sentBy: adminUid,
    expiresInMinutes: OTP_CONFIG.expirationMinutes,
    ...(OTP_CONFIG.devMode && { devOtp: otp }),
    timestamp: new Date().toISOString()
  };
};

// Bulk delete OTP sessions
export const bulkDeleteSessions = async ({ phone, purpose, olderThanHours, reason }, adminUid) => {
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
    whereClause += ` AND created_at < NOW() - make_interval(hours => $${paramIndex})`;
    params.push(olderThanHours);
    paramIndex++;
  }
  
  const result = await query(`
    DELETE FROM otp_sessions 
    ${whereClause}
    RETURNING id, phone, purpose
  `, params);
  
  const deletedCount = result.rowCount;
  
  logger.info(`🗑️ Admin bulk deleted ${deletedCount} OTP sessions - Reason: ${reason}`);
  
  return {
    deletedCount,
    filters: { phone, purpose, olderThanHours },
    reason,
    deletedBy: adminUid,
    timestamp: new Date().toISOString()
  };
};
// ── Functions referenced by adminOtpController ────────────────────────────

export const getSecurityAlerts = async (adminUid) => {
  // These are attempt-audit aggregations, so they read otp_logs — the
  // append-only attempt trail that actually carries `success`, `failure_reason`
  // and `ip_address`. otp_sessions (live challenge state) has none of those
  // columns, and pointing these queries at it made every call 500 with 42703
  // (2026-08-22 audit).
  const [suspicious, failures, ipAnalysis] = await Promise.all([
    query(`SELECT phone, COUNT(*) as count, MAX(created_at) as last_attempt
           FROM otp_logs
           WHERE success = false AND created_at > NOW() - INTERVAL '24 hours'
           GROUP BY phone HAVING COUNT(*) >= 5
           ORDER BY count DESC LIMIT 50`),
    query(`SELECT phone, purpose, COUNT(*) as failure_count
           FROM otp_logs
           WHERE success = false AND created_at > NOW() - INTERVAL '1 hour'
           GROUP BY phone, purpose ORDER BY failure_count DESC LIMIT 20`),
    query(`SELECT ip_address, COUNT(*) as attempt_count, COUNT(DISTINCT phone) as unique_phones
           FROM otp_logs
           WHERE created_at > NOW() - INTERVAL '1 hour'
           GROUP BY ip_address HAVING COUNT(*) > 10
           ORDER BY attempt_count DESC LIMIT 20`),
  ]);
  return {
    suspiciousActivity: suspicious.rows || [],
    failurePatterns: failures.rows || [],
    ipAnalysis: ipAnalysis.rows || [],
    generatedAt: new Date().toISOString(),
    requestedBy: adminUid,
  };
};

export const getActiveSessions = async (limit = 100, adminUid) => {
  // otp_sessions tracks challenge state as `verified` (not `used`) and stores
  // no client IP — the IP lives on the otp_logs attempt trail. The previous
  // select referenced both nonexistent columns, so this 500'd on every call.
  const result = await query(
    `SELECT id, phone, purpose, created_at, expires_at, attempts, verified
     FROM otp_sessions
     WHERE expires_at > NOW() AND verified = false
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return {
    activeSessions: result.rows || [],
    count: result.rowCount || 0,
    requestedBy: adminUid,
  };
};

export const getOtpStatusForPhone = async (phone, purpose = 'general') => {
  const normalizedPhone_ = normalizePhone(phone);
  const result = await query(
    `SELECT id, phone, purpose, created_at, expires_at, used, attempts
     FROM otp_sessions
     WHERE phone = $1 AND purpose = $2 AND expires_at > NOW() AND used = false
     ORDER BY created_at DESC LIMIT 1`,
    [normalizedPhone_, purpose],
  );
  const session = result.rows?.[0];
  return {
    hasActiveOTP: !!session,
    phone: normalizedPhone_,
    purpose,
    session: session || null,
  };
};

export const revokeOtp = async (phone, purpose, reason, adminUid, _req) => {
  const normalizedPhone_ = normalizePhone(phone);
  const result = await query(
    `UPDATE otp_sessions
     SET used = true, updated_at = NOW()
     WHERE phone = $1 AND purpose = $2 AND used = false AND expires_at > NOW()
     RETURNING id`,
    [normalizedPhone_, purpose],
  );
  const revokedCount = result.rowCount || 0;
  logger.info(`🔒 Admin revoked ${revokedCount} OTP sessions for ${maskPhoneForLog(normalizedPhone_)} (${purpose}) - Reason: ${reason}`);
  return {
    phone: normalizedPhone_,
    purpose,
    revokedCount,
    reason,
    revokedBy: adminUid,
    timestamp: new Date().toISOString(),
  };
};
