// src/services/auth/adminOtpService.js - Admin OTP Service

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { OTP_CONFIG } from '../../config/otpConfig.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
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
  
  const [usageStats, failureStats, topUsers] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        DATE(created_at) AS date, purpose, action,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE success = true)::int AS successful_count,
        COUNT(*) FILTER (WHERE success = false)::int AS failed_count,
        COUNT(DISTINCT phone)::int AS unique_users
      FROM otp_logs
      WHERE 1=1
      ORDER BY date DESC, purpose, action
    `,
    prisma.$queryRaw`
      SELECT failure_reason, COUNT(*)::int AS count, COUNT(DISTINCT phone)::int AS unique_users
      FROM otp_logs WHERE success = false AND failure_reason IS NOT NULL
      GROUP BY failure_reason ORDER BY count DESC
    `,
    prisma.$queryRaw`
      SELECT phone, COUNT(*)::int AS otp_requests, COUNT(DISTINCT purpose)::int AS purposes_used,
             COUNT(*) FILTER (WHERE success = true AND action = 'verify')::int AS successful_verifications
      FROM otp_logs GROUP BY phone ORDER BY otp_requests DESC LIMIT 20
    `,
  ]);
  return {
    usageStatistics: usageStats,
    failureAnalysis: failureStats,
    topUsers,
    queryPeriod: { startDate, endDate, purpose },
    generatedBy: requestedBy,
    timestamp: new Date().toISOString()
  };
  
  return {
    activeSessions: rows.map(session => ({
      ...session,
      remaining_seconds: Math.max(0, Math.floor(session.remaining_seconds))
    })),
    totalActive: rows.length,
    byPurpose,
    generatedBy: requestedBy,
    timestamp: new Date().toISOString()
  };
};

// Get OTP logs with filtering
export const getOtpLogs = async (filters, requestedBy) => {
  const { page, limit, phone, purpose, action, success, startDate, endDate, ipAddress } = filters;
  
  const offset = (page - 1) * limit;
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
  
  const [logs, totalCount] = await Promise.all([
    prisma.otp_logs.findMany({
      select: { id: true, phone: true, purpose: true, action: true, success: true, failure_reason: true, ip_address: true, user_agent: true, created_at: true, created_by: true },
      orderBy: { created_at: 'desc' },
      skip: offset,
      take: parseInt(limit),
    }),
    prisma.otp_logs.count(),
  ]);
  return {
    logs,
    pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
    filters: { phone, purpose, action, success, startDate, endDate, ipAddress },
    generatedBy: requestedBy
  };
  const revokedCount = revokedResult.count;
  
  // Log the revocation
  await otpService.logActivity(normalizedPhone, purpose || 'all', 'admin_revoke', true, reason, req);
  
  logger.info(`🔐 Admin revoked ${revokedCount} OTP(s) for ${normalizedPhone} - Reason: ${reason}`);
  
  return {
    phone: normalizedPhone,
    purpose: purpose || 'all',
    revokedCount,
    reason,
    revokedBy: adminUid,
    timestamp: new Date().toISOString()
  };
};

// Cleanup OTP logs
export const cleanupOtpLogs = async (olderThanDays, adminUid) => {
  const result = await query(
    `DELETE FROM otp_logs
     WHERE created_at < NOW() - make_interval(days => $1)`,
    [olderThanDays]
  );
  
  const deletedCount = deleteResult.count;
  
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
  const expiresAt = new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));
  
  // Store OTP
  const result = await query(`
    INSERT INTO otp_sessions (
      phone, otp, purpose, expires_at, 
      attempts, created_at, verified
    ) VALUES ($1, $2, $3, $4, 0, NOW(), false)
    RETURNING id
  `, [normalizedPhone, otp, purpose, expiresAt]);
  
  const sessionId = result.rows[0].id;
  
  // Log the admin action
  await otpService.logActivity(normalizedPhone, purpose, 'admin_force_send', true, reason, req);
  
  logger.info(`📨 Admin force-sent OTP for ${normalizedPhone} - Reason: ${reason}`);
  
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