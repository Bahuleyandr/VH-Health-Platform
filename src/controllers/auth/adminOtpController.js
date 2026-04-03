// src/controllers/auth/adminOtpController.js - Admin OTP Controller

import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as adminOtpService from '../../services/auth/adminOtpService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

// Get OTP analytics
export const getAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, purpose } = req.query;
    
    const analytics = await adminOtpService.getOtpAnalytics({
      startDate,
      endDate,
      purpose,
      requestedBy: req.user?.uid
    });
    
    await logAudit(req, 'otp-analytics-viewed', { 
      period: { startDate, endDate, purpose },
      recordCount: analytics.usageStatistics.length
    });
    
    success(res, analytics, 'OTP analytics retrieved successfully');
  } catch (err) {
    logger.error('OTP Analytics Error:', err);
    error(res, 'Failed to fetch OTP analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get security alerts
export const getSecurityAlerts = async (req, res) => {
  try {
    const alerts = await adminOtpService.getSecurityAlerts(req.user?.uid);
    
    await logAudit(req, 'otp-security-alerts-viewed', {
      suspiciousCount: alerts.suspiciousActivity.length,
      failurePatternCount: alerts.failurePatterns.length,
      suspiciousIPCount: alerts.ipAnalysis.length
    });
    
    success(res, alerts, 'OTP security alerts generated successfully');
  } catch (err) {
    logger.error('OTP Security Alerts Error:', err);
    error(res, 'Failed to generate security alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get active OTP sessions
export const getActiveSessions = async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    
    const sessions = await adminOtpService.getActiveSessions(parseInt(limit), req.user?.uid);
    
    await logAudit(req, 'otp-active-sessions-viewed', { 
      sessionCount: sessions.activeSessions.length 
    });
    
    success(res, sessions, 'Active OTP sessions retrieved successfully');
  } catch (err) {
    logger.error('Active Sessions Error:', err);
    error(res, 'Failed to fetch active sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get OTP logs
export const getOtpLogs = async (req, res) => {
  try {
    const filters = {
      page: Math.max(parseInt(req.query.page) || 1, 1),
      limit: Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 100),
      phone: req.query.phone,
      purpose: req.query.purpose,
      action: req.query.action,
      success: req.query.success,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      ipAddress: req.query.ipAddress
    };
    
    const logs = await adminOtpService.getOtpLogs(filters, req.user?.uid);
    
    await logAudit(req, 'otp-logs-viewed', {
      filters,
      resultCount: logs.logs.length
    });
    
    success(res, logs, 'OTP logs retrieved successfully');
  } catch (err) {
    logger.error('OTP Logs Error:', err);
    error(res, 'Failed to fetch OTP logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get OTP status for phone
export const getOtpStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const { purpose = 'general' } = req.query;
    
    const status = await adminOtpService.getOtpStatusForPhone(phone, purpose);
    
    success(res, status, status.hasActiveOTP ? 'OTP status retrieved' : 'No active OTP found');
  } catch (err) {
    logger.error('OTP Status Error:', err);
    error(res, 'Failed to get OTP status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Revoke OTP for user
export const revokeOtp = async (req, res) => {
  try {
    const { phone, purpose, reason } = req.body;
    
    const result = await adminOtpService.revokeOtp(phone, purpose, reason, req.user?.uid, req);
    
    await logAudit(req, 'otp-admin-revoked', {
      phone: result.phone,
      purpose: result.purpose,
      revokedCount: result.revokedCount,
      reason
    });
    
    success(res, result, `${result.revokedCount} OTP session(s) revoked successfully`);
  } catch (err) {
    logger.error('Revoke OTP Error:', err);
    error(res, 'Failed to revoke OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Cleanup OTP logs
export const cleanupLogs = async (req, res) => {
  try {
    const { olderThanDays } = req.body;
    
    const result = await adminOtpService.cleanupOtpLogs(olderThanDays, req.user?.uid);
    
    await logAudit(req, 'otp-logs-cleanup', {
      olderThanDays,
      deletedCount: result.deletedCount
    });
    
    success(res, result, `Cleaned up ${result.deletedCount} old OTP logs successfully`);
  } catch (err) {
    logger.error('OTP Logs Cleanup Error:', err);
    error(res, 'Failed to cleanup logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update OTP configuration
export const updateConfiguration = async (req, res) => {
  try {
    const updates = {
      expirationMinutes: req.body.expirationMinutes,
      maxAttempts: req.body.maxAttempts,
      dailyLimit: req.body.dailyLimit,
      resendCooldownMinutes: req.body.resendCooldownMinutes
    };
    
    const result = await adminOtpService.updateOtpConfiguration(updates, req.user?.uid);
    
    await logAudit(req, 'otp-config-updated', {
      previousConfig: result.previousConfig,
      updates: result.updates,
      newConfig: result.newConfig
    });
    
    success(res, result, 'OTP configuration updated successfully');
  } catch (err) {
    logger.error('Update Config Error:', err);
    error(res, 'Failed to update configuration', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Force send OTP
export const forceSendOtp = async (req, res) => {
  try {
    const { phone, purpose = 'admin_override', reason, bypassLimits = true } = req.body;
    
    const result = await adminOtpService.forceSendOtp(phone, purpose, reason, bypassLimits, req.user?.uid, req);
    
    await logAudit(req, 'otp-admin-force-send', {
      phone: result.phone,
      purpose,
      reason,
      bypassLimits,
      sessionId: result.sessionId
    });
    
    success(res, result, 'OTP force-sent successfully by admin');
  } catch (err) {
    logger.error('Force Send OTP Error:', err);
    error(res, 'Failed to force send OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk delete OTP sessions
export const bulkDeleteSessions = async (req, res) => {
  try {
    const { phone, purpose, olderThanHours, reason } = req.body;
    
    const result = await adminOtpService.bulkDeleteSessions({
      phone,
      purpose,
      olderThanHours,
      reason
    }, req.user?.uid);
    
    await logAudit(req, 'otp-bulk-delete', {
      filters: { phone, purpose, olderThanHours },
      deletedCount: result.deletedCount,
      reason
    });
    
    success(res, result, `Bulk deleted ${result.deletedCount} OTP sessions successfully`);
  } catch (err) {
    logger.error('Bulk Delete Sessions Error:', err);
    error(res, 'Failed to bulk delete sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};