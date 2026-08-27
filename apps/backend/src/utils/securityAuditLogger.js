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
import { normalizeAuditLogUserId } from './auditLogIdentity.js';
import { recordSecurityEvent } from '../observability/securityEventMetrics.js';
import { redactSensitiveQueryParams } from './urlRedaction.js';

let pendingSecurityLogs = 0;
const MAX_PENDING_SECURITY_LOGS = 500;

/** Wait for detached security-audit writes before graceful shutdown or
 *  tenant-fixture disposal. This is never part of the request path. */
export async function waitForSecurityAuditDrain({ timeoutMs = 10000, pollMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (pendingSecurityLogs > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${pendingSecurityLogs} security audit write(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Log a security event to the audit_log table.
 * @param {string} eventType - e.g. 'LOGIN_FAILED', 'ACCOUNT_LOCKED', 'PERMISSION_DENIED', 'TOKEN_REVOKED'
 * @param {Object} details - Event details
 * @param {string} [details.userId] - User ID (if known)
 * @param {string} [details.userName] - Username/email/phone (if known)
 * @param {string} [details.userRole] - User role (if known)
 * @param {string} [details.tenantId] - Server-resolved tenant ID (if known)
 * @param {string} [details.ip] - Client IP address
 * @param {string} [details.userAgent] - Client user-agent
 * @param {string} [details.path] - Request path
 * @param {string} [details.method] - HTTP method
 * @param {string} [details.reason] - Failure reason (for logging, not client-facing)
 */
export function logSecurityEvent(eventType, details = {}) {
  // Counter first — cheap, synchronous, and immune to the queue backpressure
  // below, so the metric reflects every event even when the DB path drops to
  // file-only.
  recordSecurityEvent(eventType);
  const safeDetails = {
    ...details,
    path: redactSensitiveQueryParams(details.path),
  };

  // Backpressure: drop if queue is full to prevent OOM
  if (pendingSecurityLogs >= MAX_PENDING_SECURITY_LOGS) {
    logger.warn('Security audit queue full, logging to file only:', { eventType, userId: safeDetails.userId });
    _logToFile(eventType, safeDetails);
    return;
  }

  pendingSecurityLogs++;

  // Fire-and-forget with bounded queue
  setImmediate(async () => {
    try {
      const tenantId = safeDetails.tenantId || safeDetails.tenant_id || null;
      const tenantColumn = tenantId ? ', tenant_id' : '';
      const tenantValue = tenantId ? ',$15::uuid' : '';
      await prisma.$queryRawUnsafe(`
        INSERT INTO audit_log
          (user_id, user_name, user_role, ip_address, method, path, module, action,
           query_params, request_summary, status_code, response_time_ms, success, user_agent${tenantColumn})
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14${tenantValue})
      `, 
        normalizeAuditLogUserId(safeDetails.userId),
        safeDetails.userName || null,
        safeDetails.userRole || null,
        safeDetails.ip || null,
        safeDetails.method || 'POST',
        safeDetails.path || '/auth',
        'security',
        eventType,
        null,
        safeDetails.reason ? JSON.stringify({ reason: safeDetails.reason }) : null,
        safeDetails.statusCode || 401,
        0,
        false,
        (safeDetails.userAgent || '').substring(0, 200),
        ...(tenantId ? [tenantId] : []),
      );
    } catch (err) {
      _logToFile(eventType, safeDetails, err?.message);
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
    tenantId: details.tenantId || details.tenant_id || null,
    ip: details.ip,
    path: details.path,
    reason: details.reason,
    timestamp: new Date().toISOString(),
    ...(dbError && { dbError }),
  });
}
