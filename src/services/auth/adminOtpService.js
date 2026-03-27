// src/services/auth/adminOtpService.js - Admin OTP Service

import crypto from 'crypto';
import db from '../../config/database.js';
import { OTP_CONFIG } from '../../config/otpConfig.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import * as otpService from './otpService.js';

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
    // Usage statistics
    db.query(`
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
    db.query(`
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
    db.query(`
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
  
  return {
    usageStatistics: usageStats.rows,
    failureAnalysis: failureStats.rows,
    topUsers: topUsers.rows,
    queryPeriod: { startDate, endDate, purpose },
    generatedBy: requestedBy,
    timestamp: new Date().toISOString()
  };
};

// Get security alerts
export const getSecurityAlerts = async (requestedBy) => {
  const [suspiciousActivity, failurePatterns, ipAnalysis] = await Promise.all([
    // Unusual OTP activity patterns
    db.query(`
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
    db.query(`
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
    db.query(`
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
  
  return {
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
  };
};

// Get active OTP sessions
export const getActiveSessions = async (limit, requestedBy) => {
  const result = await db.query(`
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
  
  return {
    activeSessions: result.rows.map(session => ({
      ...session,
      remaining_seconds: Math.max(0, Math.floor(session.remaining_seconds))
    })),
    totalActive: result.rows.length,
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
  
  const [logs, total] = await Promise.all([
    db.query(`
      SELECT 
        id, phone, purpose, action, success, failure_reason,
        ip_address, user_agent, created_at, created_by
      FROM otp_logs 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, params),
    
    db.query(
      `SELECT COUNT(*) FROM otp_logs ${whereClause}`,
      params.slice(2)
    )
  ]);
  
  return {
    logs: logs.rows,
    pagination: {
      page,
      limit,
      total: parseInt(total.rows[0].count),
      totalPages: Math.ceil(total.rows[0].count / limit)
    },
    filters: { phone, purpose, action, success, startDate, endDate, ipAddress },
    generatedBy: requestedBy
  };
};

// Get OTP status for phone
export const getOtpStatusForPhone = async (phone, purpose) => {
  const normalizedPhone = normalizePhone(phone);
  
  const result = await db.query(`
    SELECT id, attempts, expires_at, verified, created_at, purpose
    FROM otp_sessions 
    WHERE phone = $1 AND purpose = $2 AND verified = false
    ORDER BY created_at DESC 
    LIMIT 1
  `, [normalizedPhone, purpose]);
  
  if (result.rows.length === 0) {
    return {
      phone: normalizedPhone,
      purpose,
      hasActiveOTP: false,
      canRequest: true
    };
  }
  
  const session = result.rows[0];
  const now = new Date();
  const expiresAt = new Date(session.expires_at);
  const isExpired = now > expiresAt;
  const remainingTime = Math.max(0, expiresAt.getTime() - now.getTime());
  
  return {
    phone: normalizedPhone,
    purpose,
    hasActiveOTP: !isExpired,
    attemptsUsed: session.attempts,
    attemptsRemaining: Math.max(0, OTP_CONFIG.maxAttempts - session.attempts),
    expiresInSeconds: Math.floor(remainingTime / 1000),
    sessionId: session.id,
    createdAt: session.created_at
  };
};

// Revoke OTP
export const revokeOtp = async (phone, purpose, reason, adminUid, req) => {
  const normalizedPhone = normalizePhone(phone);
  
  let whereClause = 'phone = $1 AND verified = false';
  const params = [normalizedPhone];
  
  if (purpose) {
    whereClause += ' AND purpose = $2';
    params.push(purpose);
  }
  
  // Revoke OTP sessions
  const result = await db.query(`
    UPDATE otp_sessions 
    SET verified = true, verified_at = NOW() 
    WHERE ${whereClause}
    RETURNING id, purpose
  `, params);
  
  const revokedCount = result.rowCount;
  
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
  const result = await db.query(
    `DELETE FROM otp_logs
     WHERE created_at < NOW() - make_interval(days => $1)`,
    [olderThanDays]
  );
  
  const deletedCount = result.rowCount;
  
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
  const result = await db.query(`
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
  
  const result = await db.query(`
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