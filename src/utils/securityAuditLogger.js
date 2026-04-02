/**
 * Security Audit Logger
 * Logs security-relevant events (failed logins, lockouts, permission denials, etc.)
 * to the audit_log table with module='security'.
 *
 * Uses a bounded queue with backpressure to prevent memory leaks when DB is down.
 * Falls back to Winston file logging when DB writes fail.
 */

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

let pendingSecurityLogs = 0;
const MAX_PENDING_SECURITY_LOGS = 500;

/**
 * Log a security event to the audit_log table.
 * @param {string} eventType - e.g. 'LOGIN_FAILED', 'ACCOUNT_LOCKED', 'PERMISSION_DENIED', 'TOKEN_REVOKED'
 * @param {Object} details - Event details
 * @param {string} [details.userId] - User ID (if known)
 * @param {string} [details.userName] - Username/email/phone (if known)
 * @param {string} [details.userRole] - User role (if known)
 * @param {string} [details.ip] - Client IP address
 * @param {string} [details.userAgent] - Client user-agent
 * @param {string} [details.path] - Request path
 * @param {string} [details.method] - HTTP method
 * @param {string} [details.reason] - Failure reason (for logging, not client-facing)
 */
export function logSecurityEvent(eventType, details = {}) {
  // Backpressure: drop if queue is full to prevent OOM
  if (pendingSecurityLogs >= MAX_PENDING_SECURITY_LOGS) {
    logger.warn('Security audit queue full, logging to file only:', { eventType, userId: details.userId });
    _logToFile(eventType, details);
    return;
  }

  pendingSecurityLogs++;

  // Fire-and-forget with bounded queue
  setImmediate(async () => {
    try {
      await prisma.$queryRawUnsafe(`
        INSERT INTO audit_log
          (user_id, user_name, user_role, ip_address, method, path, module, action,
           query_params, request_summary, status_code, response_time_ms, success, user_agent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [
        details.userId || null,
        details.userName || null,
        details.userRole || null,
        details.ip || null,
        details.method || 'POST',
        details.path || '/auth',
        'security',
        eventType,
        null,
        details.reason ? JSON.stringify({ reason: details.reason }) : null,
        details.statusCode || 401,
        0,
        false,
        (details.userAgent || '').substring(0, 200),
      ]);
    } catch (err) {
      _logToFile(eventType, details, err?.message);
    } finally {
      pendingSecurityLogs--;
    }
  });
}

// Convenience methods for common security events (typed interface)
export const SecurityEvents = {
  loginFailed: (userId, ip, reason, extra = {}) =>
    logSecurityEvent('LOGIN_FAILED', { userId, ip, reason, ...extra }),

  accountLocked: (userId, ip, reason, extra = {}) =>
    logSecurityEvent('ACCOUNT_LOCKED', { userId, ip, reason, ...extra }),

  permissionDenied: (userId, path, userRole, extra = {}) =>
    logSecurityEvent('PERMISSION_DENIED', { userId, path, userRole, ...extra }),

  tokenRevoked: (userId, reason, extra = {}) =>
    logSecurityEvent('TOKEN_REVOKED', { userId, reason, ...extra }),

  suspiciousActivity: (userId, ip, reason, extra = {}) =>
    logSecurityEvent('SUSPICIOUS_ACTIVITY', { userId, ip, reason, ...extra }),
};

function _logToFile(eventType, details, dbError) {
  logger.warn('SECURITY_EVENT (file fallback):', {
    eventType,
    userId: details.userId,
    userName: details.userName,
    ip: details.ip,
    path: details.path,
    reason: details.reason,
    timestamp: new Date().toISOString(),
    ...(dbError && { dbError }),
  });
}
